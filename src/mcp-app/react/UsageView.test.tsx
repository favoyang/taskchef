import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { UsageView, type UsageData } from './UsageView';
afterEach(cleanup);
const data:UsageData={start:'2026-10-01',end:'2026-10-15',timeZone:'Asia/Singapore',samples:2,incomplete:false,totals:{tokens:200,costUsd:3,inputTokens:160,cachedInputTokens:40,outputTokens:40},days:[{date:'2026-10-15',tokens:200,costUsd:3,projects:{a:2,b:1}}],projects:[{id:'a',name:'Alpha',tokens:100,costUsd:2},{id:'b',name:'Beta',tokens:100,costUsd:1}]};
test('defaults to month to date, changes range, isolates projects, and exposes exact day values',async()=>{
 const request=vi.fn().mockResolvedValue(data);render(<UsageView request={request}/>);
 await waitFor(()=>expect(screen.getByRole('table')).toBeVisible());
 expect(request).toHaveBeenCalledWith({range:'mtd',timeZone:expect.any(String),force:true});
 expect(screen.queryByText(/Custom/)).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'7 days'}));
 await waitFor(()=>expect(request).toHaveBeenLastCalledWith({range:'7d',timeZone:expect.any(String),force:true}));
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
 await screen.findByText(/No timestamped usage/);expect(screen.getByText(/Incomplete coverage:/)).toBeVisible();expect(screen.queryByRole('table')).toBeNull();
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
