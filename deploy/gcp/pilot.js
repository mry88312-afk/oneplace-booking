import { bookingEntryParams, bookingLoginRedirect, isBookingType } from '../../shared/bookingEntry';

const liffId = 'PILOT_LIFF';
const status = document.getElementById('status');
const choices = document.getElementById('choices');

async function openBooking() {
  await liff.init({ liffId });
  const params = bookingEntryParams(location.search);
  const type = params.get('type');
  if (isBookingType(type)) {
    location.replace(bookingLoginRedirect(location.origin, type, params));
    return;
  }

  for (const project of ['renewal', 'checkout']) {
    const target = bookingLoginRedirect(location.origin, project, params);
    const query = new URL(target).searchParams;
    query.set('type', project);
    document.getElementById(project).href = '/?' + query.toString();
  }
  status.textContent = '請選擇要辦理的項目。';
  choices.hidden = false;
}

openBooking().catch(() => {
  status.textContent = '無法開啟預約，請從 LINE 重新開啟連結。';
});
