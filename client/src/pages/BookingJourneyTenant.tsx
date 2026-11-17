import { trpc } from '@/lib/trpc';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

export default function BookingJourneyTenant({reference}:{reference:string}) {
  const result=trpc.booking.journeyTenant.useQuery({reference},{retry:false});
  return <div className="max-w-3xl mx-auto p-6"><Card><CardHeader><CardTitle>這次造訪對應的租客</CardTitle></CardHeader><CardContent className="space-y-4">
    <p>依這次造訪登入的 LINE 帳號查詢。下列為帳號關聯合約，不代表本次選定的房間。</p>
    {result.isLoading?<p>讀取中…</p>:result.error?<p role="alert">讀取失敗，請確認後台權限後重試。</p>:!result.data?.length?<p>沒有可查看的對應資料，可能尚未建立、已超過 180 天，或租客資料未同步。</p>:result.data.map((r,i)=><div key={i} className="border rounded p-3"><p className="font-semibold">{r.name}</p><p>{r.property||'未提供案場'} · {r.room||'未提供房間'}</p><p>合約到期：{r.end_date||'未提供'}</p></div>)}
    <Button onClick={()=>location.assign('/admin')}>回預約後台</Button>
  </CardContent></Card></div>;
}
