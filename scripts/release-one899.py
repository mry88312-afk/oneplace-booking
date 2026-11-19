"""在 prod-vm 以 sudo 執行；stage 完成後才可 activate。秘密只在程序內與 Docker socket 傳遞。"""
import copy
import hashlib
import http.client
import json
import pathlib
import shutil
import socket
import subprocess
import sys
import urllib.request
import urllib.error

ROOT = pathlib.Path('/srv/one899-booking')
SITE = pathlib.Path('/etc/caddy/sites/booking.caddy')
OLD_APP = 'booking-public-bd4a99070205'
OLD_GATE = 'booking-line-b76d1d8c9dce'

def run(*args):
    return subprocess.check_output(args, text=True).strip()

def inspect(name):
    return json.loads(run('docker', 'inspect', name))[0]

def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()

class DockerConnection(http.client.HTTPConnection):
    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.connect('/var/run/docker.sock')

def docker_api(method, path, payload=None):
    connection = DockerConnection('localhost')
    connection.request(method, '/v1.41' + path, json.dumps(payload) if payload else None,
                       {'Content-Type': 'application/json'})
    response = connection.getresponse()
    body = response.read()
    if response.status not in (200, 201, 204):
        raise RuntimeError('Docker operation failed: ' + str(response.status))
    return json.loads(body) if body else {}

def clone(old, name, image, gate_dir=None, bridge=None):
    config = copy.deepcopy(old['Config'])
    config['Hostname'] = ''
    config['Image'] = image
    host = copy.deepcopy(old['HostConfig'])
    host['PortBindings'] = {'3000/tcp': [{'HostIp': '127.0.0.1', 'HostPort': ''}]}
    host['LogConfig'] = {'Type': 'json-file', 'Config': {'max-size': '4m', 'max-file': '3'}}
    if gate_dir:
        host.pop('Mounts', None)
        host['Binds'] = [str(gate_dir) + ':/gate:ro']
    if bridge:
        assert sum(e.startswith('BOOKING_REMITTANCE_BRIDGE=') for e in config['Env']) == 1
        config['Env'] = [('BOOKING_REMITTANCE_BRIDGE=' + bridge) if e.startswith('BOOKING_REMITTANCE_BRIDGE=') else e for e in config['Env']]
    config['HostConfig'] = host
    result = docker_api('POST', '/containers/create?name=' + name, config)
    docker_api('POST', '/containers/' + result['Id'] + '/start')
    return inspect(name)

def port(container):
    return container['NetworkSettings']['Ports']['3000/tcp'][0]['HostPort']

def status(url, data=None):
    try:
        with urllib.request.urlopen(urllib.request.Request(url, data=data), timeout=15) as response:
            return response.status
    except urllib.error.HTTPError as error:
        return error.code

action, tag = sys.argv[1:]
assert len(tag) == 12 and all(c in '0123456789abcdef' for c in tag)
release = ROOT / tag
current = SITE.read_text()
assert 'X-OnePlace-Release bd4a99070205' in current, '正式版本已變更，停止'

if action == 'stage':
    assert not (release / 'receipt.json').exists(), '已完成 stage，勿重送'
    old_app, old_gate = inspect(OLD_APP), inspect(OLD_GATE)
    gate_dir = release / 'gate'
    assert not gate_dir.exists(), 'stage 已啟動過，先查現況'
    shutil.copytree(old_gate['Mounts'][0]['Source'], gate_dir)
    for filename in ['renewal-gateway.cjs', 'renewal-gateway.test.cjs']:
        shutil.copy2(release / 'deploy/gcp' / filename, gate_dir / filename)
    subprocess.run(['docker', 'run', '--rm', '--network', 'none', '-v', str(gate_dir) + ':/gate:ro',
                    old_gate['Config']['Image'], 'node', '/gate/renewal-gateway.test.cjs'], check=True)
    image = 'one899-booking:' + tag
    (release / 'Dockerfile').write_text('FROM ' + old_app['Config']['Image'] + '\nCOPY dist/ /app/dist/\n')
    subprocess.run(['docker', 'build', '-t', image, str(release)], check=True)
    gate_name = 'booking-verification-line-' + tag
    gate = clone(old_gate, gate_name, old_gate['Config']['Image'], gate_dir=gate_dir)
    app_name = 'booking-verification-public-' + tag
    app = clone(old_app, app_name, image, bridge='http://' + gate_name + ':3000')
    before = current
    assert current.count('127.0.0.1:32799') == 4
    assert current.count('127.0.0.1:32794') == 1
    current = current.replace('127.0.0.1:32799', '127.0.0.1:' + port(app))
    current = current.replace('127.0.0.1:32794', '127.0.0.1:' + port(gate))
    current = current.replace('X-OnePlace-Release bd4a99070205', 'X-OnePlace-Release ' + tag)
    template = (release / 'deploy/gcp/full-site.caddy').read_text()
    log_config = template.split('    @wrongHost')[0].split('{', 1)[1]
    current = current.replace('booking.oneplace.com.tw {', 'booking.oneplace.com.tw {' + log_config, 1)
    (release / 'before.caddy').write_text(before)
    (release / 'candidate.caddy').write_text(current)
    subprocess.run(['caddy', 'validate', '--config', str(release / 'candidate.caddy'), '--adapter', 'caddyfile'], check=True)
    # root 驗證會建立檔案；交回實際 Caddy 使用者，確保 reload 可開啟與輪替。
    run('chown', 'caddy:caddy', '/var/log/caddy/booking-access.json')
    receipt = {'tag': tag, 'app': app_name, 'gate': gate_name, 'appPort': port(app), 'gatePort': port(gate),
               'beforeHash': digest(before), 'oldEnvHash': digest(old_app['Config']['Env']),
               'newEnvHash': digest(app['Config']['Env']),
               'changedEnvNames': ['BOOKING_REMITTANCE_BRIDGE'], 'gatewayTest': 'passed'}
    original_env = [e for e in old_app['Config']['Env'] if not e.startswith('BOOKING_REMITTANCE_BRIDGE=')]
    candidate_env = [e for e in app['Config']['Env'] if not e.startswith('BOOKING_REMITTANCE_BRIDGE=')]
    assert original_env == candidate_env
    (release / 'receipt.json').write_text(json.dumps(receipt, indent=2))
    print(json.dumps(receipt))
elif action == 'activate':
    receipt = json.loads((release / 'receipt.json').read_text())
    assert digest(current) == receipt['beforeHash'], '設定已變更，停止'
    assert status('http://127.0.0.1:' + receipt['appPort'] + '/book/checkout') == 200
    assert status('http://127.0.0.1:' + receipt['gatePort'] + '/principal') == 403
    try:
        SITE.write_text((release / 'candidate.caddy').read_text())
        subprocess.run(['caddy', 'validate', '--config', '/etc/caddy/Caddyfile'], check=True)
        subprocess.run(['systemctl', 'reload', 'caddy'], check=True)
        with urllib.request.urlopen('https://booking.oneplace.com.tw/book/checkout', timeout=20) as response:
            assert response.status == 200
            assert response.headers['X-OnePlace-Release'] == tag
        assert status('https://booking.oneplace.com.tw/one899-invalid-link?token=redaction-probe') == 404
    except Exception:
        SITE.write_text((release / 'before.caddy').read_text())
        subprocess.run(['systemctl', 'reload', 'caddy'], check=True)
        raise
    receipt['activated'] = True
    (release / 'receipt.json').write_text(json.dumps(receipt, indent=2))
    print(json.dumps(receipt))
else:
    raise ValueError('只接受 stage 或 activate')
