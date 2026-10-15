import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { UsageView, type UsageData } from './UsageView';
afterEach(cleanup);
const data:UsageData={start:'2026-10-01',end:'2026-10-15',timeZone:'Asia/Singapore',samples:2,incomplete:false,totals:{tokens:200,costUsd:3,inputTokens:160,cachedInputTokens:40,outputTokens:40},days:[{date:'2026-10-15',tokens:200,costUsd:3,projects:{a:2,b:1}}],projects:[{id:'a',name:'Alpha',tokens:100,costUsd:2},{id:'b',name:'Beta',tokens:100,costUsd:1}]};
test('defaults to This month, changes range, isolates projects, and exposes exact day values',async()=>{
 const request=vi.fn().mockResolvedValue(data);render(<UsageView request={request}/>);
 await waitFor(()=>expect(screen.getByRole('table')).toBeVisible());
 expect(request).toHaveBeenCalledWith({range:'mtd',timeZone:expect.any(String)});
 expect(screen.queryByText(/Custom/)).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'7 days'}));
 await waitFor(()=>expect(request).toHaveBeenLastCalledWith({range:'7d',timeZone:expect.any(String)}));
 await waitFor(()=>expect(screen.getByRole('table')).toBeVisible());
 fireEvent.click(screen.getByRole('button',{name:'Alpha'}));
 expect(screen.getByRole('img',{name:'Daily project cost bars: Alpha'})).toBeVisible();
 fireEvent.click(screen.getByRole('button',{name:'All projects'}));
 expect(screen.getByRole('img',{name:'Daily project cost bars: all projects'})).toBeVisible();
 fireEvent.focus(screen.getByRole('button',{name:'Oct 15: $3.00, 200 tokens'}));
 expect(screen.getByText('Oct 15 · 200 tokens · $3.00')).toBeVisible();
});
test('a late old response cannot replace the selected range and errors can retry',async()=>{
 let first!:(value:UsageData)=>void;const request=vi.fn().mockImplementationOnce(()=>new Promise<UsageData>(resolve=>{first=resolve;})).mockRejectedValueOnce(new Error('Read failed')).mockResolvedValue(data);
 render(<UsageView request={request}/>);fireEvent.click(screen.getByRole('button',{name:'90 days'}));
 expect(await screen.findByRole('alert')).toHaveTextContent('Read failed');
 first(data);await Promise.resolve();expect(screen.queryByRole('table')).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'Retry'}));await waitFor(()=>expect(screen.getByRole('table')).toBeVisible());
});
test('missing coverage and empty data are distinct from a zero cost estimate',async()=>{
 const request=vi.fn().mockResolvedValue({...data,samples:0,incomplete:true});render(<UsageView request={request}/>);
 await screen.findByText(/No timestamped usage/);expect(screen.queryByText(/Incomplete coverage:/)).toBeNull();expect(screen.queryByRole('table')).toBeNull();
});
test('ranks only ten projects and keeps Other out of project identity',async()=>{
 const projects=Array.from({length:12},(_,i)=>({id:String(i),name:`Project ${i}`,tokens:1,costUsd:12-i}));
 const request=vi.fn().mockResolvedValue({...data,projects});render(<UsageView request={request}/>);
 await waitFor(()=>expect(screen.getByRole('table')).toBeVisible());expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(11);expect(screen.getByText('Other')).toBeVisible();
});

test('polls a pending history read and stops polling when unmounted',async()=>{
 const request=vi.fn().mockResolvedValueOnce({loading:true}).mockResolvedValue(data);
 const view=render(<UsageView request={request}/>);expect(await screen.findByRole('status')).toHaveTextContent('Reading saved usage');
 await waitFor(()=>expect(screen.getByRole('table')).toBeVisible(),{timeout:2000});
 expect(request).toHaveBeenLastCalledWith({range:'mtd',timeZone:expect.any(String)});
 view.unmount();
 const pending=vi.fn().mockResolvedValue({loading:true});const second=render(<UsageView request={pending}/>);await waitFor(()=>expect(pending).toHaveBeenCalledTimes(1));second.unmount();
});

test('a hidden view does not start historical usage reads',async()=>{
 const visibility=vi.spyOn(document,'visibilityState','get').mockReturnValue('hidden');
 try {const request=vi.fn().mockResolvedValue(data);render(<UsageView request={request}/>);expect(request).not.toHaveBeenCalled();visibility.mockReturnValue('visible');await waitFor(()=>expect(screen.getByRole('table')).toBeVisible(),{timeout:2000});expect(request).toHaveBeenCalledTimes(1);}
 finally{visibility.mockRestore();}
});

test('Last month follows This month and range changes reuse history without forcing a scan',async()=>{
 const request=vi.fn().mockResolvedValue(data);render(<UsageView request={request}/>);
 await waitFor(()=>expect(screen.getByRole('table')).toBeVisible());
 const buttons=within(screen.getByRole('group',{name:'Usage time range'})).getAllByRole('button');
 expect(buttons.map(button=>button.textContent)).toEqual(['7 days','30 days','90 days','This month','Last month']);
 fireEvent.click(screen.getByRole('button',{name:'Last month'}));await waitFor(()=>expect(request).toHaveBeenLastCalledWith({range:'last-month',timeZone:expect.any(String)}));
 fireEvent.click(screen.getByRole('button',{name:'This month'}));await waitFor(()=>expect(request).toHaveBeenCalledTimes(3));expect(request.mock.calls.every(([args])=>!args.force)).toBe(true);
});
test('Refresh forces one new read and shows measured progress while cached data stays visible',async()=>{
 const request=vi.fn().mockResolvedValueOnce(data).mockResolvedValueOnce({...data,refreshing:true,progress:{completed:2,total:10}}).mockResolvedValue(data);
 const view=render(<UsageView request={request}/>);await waitFor(()=>expect(screen.getByRole('table')).toBeVisible());
 view.rerender(<UsageView request={request} refreshKey={1}/>);
 await screen.findByText('Updating saved usage… 2 of 10 chats');expect(screen.getByRole('progressbar',{name:'Usage scan progress'})).toHaveAttribute('value','2');expect(screen.getByRole('table')).toBeVisible();
 expect(request).toHaveBeenLastCalledWith({range:'mtd',timeZone:expect.any(String),force:true});await waitFor(()=>expect(screen.queryByRole('progressbar')).toBeNull());
});
test('legend hover and focus highlight only matching project bars and reset on leave',async()=>{
 const request=vi.fn().mockResolvedValue(data);const view=render(<UsageView request={request}/>);await waitFor(()=>expect(screen.getByRole('table')).toBeVisible());
 const alpha=screen.getByRole('button',{name:'Alpha'});fireEvent.mouseEnter(alpha);
 expect(view.container.querySelector('[data-project="a"]')).toHaveAttribute('opacity','1');expect(view.container.querySelector('[data-project="b"]')).toHaveAttribute('opacity','0.2');
 fireEvent.mouseLeave(alpha);expect(view.container.querySelector('[data-project="b"]')).toHaveAttribute('opacity','1');
 fireEvent.focus(alpha);expect(view.container.querySelector('[data-project="b"]')).toHaveAttribute('opacity','0.2');fireEvent.blur(alpha);expect(view.container.querySelector('[data-project="b"]')).toHaveAttribute('opacity','1');
});

 test('Rescan rebuilds explicitly and removes coverage and axis helper copy',async()=>{
 const request=vi.fn().mockResolvedValue({...data,incomplete:true});render(<UsageView request={request}/>);
 await screen.findByRole('table');
 for(const text of [/Incomplete coverage/,/Known subtotal/,/Cached input is included/,/right axis/,/left axis/,/By estimated cost/,/Missing usage is not zero/]) expect(screen.queryByText(text)).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'Rescan'}));
 await waitFor(()=>expect(request).toHaveBeenLastCalledWith({range:'mtd',timeZone:expect.any(String),rescan:true}));
 });

test('only the current local day has dashed bars and token segment; a completed period stays solid',async()=>{
 vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-10-15T17:00:00Z'));
 try {
  const days=[{...data.days[0],date:'2026-10-15'},{...data.days[0],date:'2026-10-16'}];
  const request=vi.fn().mockResolvedValueOnce({...data,end:'2026-10-16',days}).mockResolvedValue({...data,start:'2026-09-01',end:'2026-09-30',days:[{...data.days[0],date:'2026-09-30'}]});
  render(<UsageView request={request}/>);await screen.findByRole('table');
  const combined=screen.getByRole('img',{name:'Daily estimated cost bars and token line'});
  expect(combined.querySelectorAll('rect[stroke-dasharray]')).toHaveLength(1);
  expect(combined.querySelectorAll('polyline[stroke-dasharray]')).toHaveLength(1);
  expect(screen.getByRole('button',{name:/Oct 16: .*in progress/})).toBeVisible();
  const projects=screen.getByRole('img',{name:'Daily project cost bars: all projects'});
  expect(projects.querySelectorAll('rect[stroke-dasharray]')).toHaveLength(2);
  fireEvent.click(screen.getByRole('button',{name:'Alpha'}));
  expect(screen.getByRole('img',{name:'Daily project cost bars: Alpha'}).querySelectorAll('rect[stroke-dasharray]')).toHaveLength(1);
  fireEvent.click(screen.getByRole('button',{name:'Last month'}));
  await waitFor(()=>expect(screen.getByText(/Sep 1 – Sep 30/)).toBeVisible());
  expect(screen.getByRole('img',{name:'Daily estimated cost bars and token line'}).querySelectorAll('[stroke-dasharray]')).toHaveLength(0);
  expect(screen.getByRole('img',{name:'Daily project cost bars: Alpha'}).querySelectorAll('[stroke-dasharray]')).toHaveLength(0);
 } finally {vi.useRealTimers();}
});
