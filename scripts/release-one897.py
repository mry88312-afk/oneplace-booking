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
OLD_APP = 'one824-public-bd4a99070205'
OLD_GATE = 'one824-line-b76d1d8c9dce'

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
assert len(tag)==12 and all(c in '0123456789abcdef' for c in tag)
ROOT=pathlib.Path('/srv/one897-booking')
release=ROOT/tag
old_name='one897-public-54773c111d27'
old=inspect(old_name)
current=SITE.read_text()
if action=='stage':
    # 必須檢查此次交付的資產，不能讓舊映像殘留的檔案掩蓋錯誤。
    assets=list((release/'dist/public/assets').glob('*.js'))
    assert any('/booking-link/line-session' in p.read_text() for p in assets), '缺少正式 LINE 驗證建置設定'
    assert 'X-OnePlace-Release 54773c111d27' in current
    assert not (release/'receipt.json').exists()
    oldport=port(old)
    assert current.count('127.0.0.1:'+oldport)==4
    image='one897-booking:'+tag
    (release/'Dockerfile').write_text('FROM '+old['Config']['Image']+'\nCOPY dist/ /app/dist/\n')
    subprocess.run(['docker','build','-t',image,str(release)],check=True)
    app=clone(old,'one897-public-'+tag,image)
    assert old['Config']['Env']==app['Config']['Env']
    assert old['Mounts']==app['Mounts']
    candidate=current.replace('127.0.0.1:'+oldport,'127.0.0.1:'+port(app)).replace('X-OnePlace-Release 54773c111d27','X-OnePlace-Release '+tag)
    old_entry=pathlib.Path('/var/www/one897-54773c111d27')
    assert str(old_entry) in current
    new_entry=pathlib.Path('/var/www/one897-'+tag)
    assert not new_entry.exists()
    shutil.copytree(old_entry,new_entry)
    shutil.copy2(release/'pilot.js',new_entry/'pilot.js')
    (new_entry/'pilot.js').chmod(0o644)
    candidate=candidate.replace(str(old_entry),str(new_entry))
    (release/'before.caddy').write_text(current)
    (release/'candidate.caddy').write_text(candidate)
    subprocess.run(['caddy','validate','--config',str(release/'candidate.caddy'),'--adapter','caddyfile'],check=True)
    run('chown','caddy:caddy','/var/log/caddy/booking-access.json')
    receipt={'tag':tag,'app':app['Name'].lstrip('/'),'appPort':port(app),'oldApp':old_name,'beforeHash':digest(current),'envHash':digest(app['Config']['Env']),'mountHash':digest(app['Mounts']),'activated':False}
    (release/'receipt.json').write_text(json.dumps(receipt,indent=2))
    print(json.dumps(receipt))
elif action=='activate':
    receipt=json.loads((release/'receipt.json').read_text())
    assert digest(current)==receipt['beforeHash']
    assert inspect(receipt['app'])['State']['Running']
    assert status('http://127.0.0.1:'+receipt['appPort']+'/healthz')==200
    assert status('http://127.0.0.1:'+receipt['appPort']+'/book/checkout')==200
    try:
        SITE.write_text((release/'candidate.caddy').read_text())
        subprocess.run(['caddy','validate','--config','/etc/caddy/Caddyfile'],check=True)
        run('chown','caddy:caddy','/var/log/caddy/booking-access.json')
        subprocess.run(['systemctl','reload','caddy'],check=True)
        for path in ['/healthz','/book/checkout','/book/renewal']:
            with urllib.request.urlopen('https://booking.oneplace.com.tw'+path,timeout=20) as r:
                assert r.status==200 and r.headers['X-OnePlace-Release']==tag
    except Exception:
        SITE.write_text((release/'before.caddy').read_text())
        subprocess.run(['systemctl','reload','caddy'],check=True)
        raise
    receipt['activated']=True
    (release/'receipt.json').write_text(json.dumps(receipt,indent=2))
    print(json.dumps(receipt))
else: raise ValueError('stage or activate only')
