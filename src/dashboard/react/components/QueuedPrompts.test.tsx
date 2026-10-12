import { MantineProvider } from '@mantine/core';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { QueuedPrompts } from './QueuedPrompts';
import { fixtureTask } from '../fixtures';
afterEach(()=>{cleanup();vi.restoreAllMocks();});
const prompts=[{id:'first',text:'First follow-up',images:[]},{id:'second',text:'Second follow-up\n'+ 'More details. '.repeat(30),images:[]}];
test('queue preserves execution order and removes started prompts on refresh',()=>{
 const task={...fixtureTask(),queuedPrompts:prompts};
 const {rerender}=render(<MantineProvider><QueuedPrompts task={task} compact /></MantineProvider>);
 expect(screen.getByText('2 queued')).toBeVisible();
 expect(screen.getAllByRole('listitem')[0]).toHaveTextContent('First follow-up');
 for (const item of screen.getAllByRole('listitem')) expect(item.firstElementChild).toHaveClass('taskchef-queue-icon');
 rerender(<MantineProvider><QueuedPrompts task={{...task,queuedPrompts:prompts.slice(1)}} compact /></MantineProvider>);
 expect(screen.getByText('1 queued')).toBeVisible(); expect(screen.queryByText('First follow-up')).toBeNull();
 rerender(<MantineProvider><QueuedPrompts task={{...task,queuedPrompts:[]}} compact /></MantineProvider>);
 expect(screen.queryByRole('region',{name:'Queued prompts'})).toBeNull();
});
test('Details provides expansion and clickable queued image thumbnails', async()=>{
 vi.spyOn(HTMLElement.prototype,'scrollHeight','get').mockReturnValue(200);
 vi.spyOn(HTMLElement.prototype,'clientHeight','get').mockReturnValue(60);
 const load=vi.fn().mockResolvedValue('data:image/png;base64,iVBORw0KGgo=');
 const task={...fixtureTask(),queuedPrompts:[{...prompts[1],images:[{url:'taskchef-queue:second:0',alt:'Queued screenshot'}]}]};
 render(<MantineProvider><QueuedPrompts task={task} loadImage={load}/></MantineProvider>);
 expect(screen.getByText('Queued prompts (1)')).toBeVisible();
 expect(screen.getByRole('listitem').firstElementChild).toHaveClass('taskchef-queue-icon');
 fireEvent.click(screen.getByRole('button',{name:'Show more…'}));
 expect(screen.getByRole('button',{name:'Show less'})).toHaveAttribute('aria-expanded','true');
 const thumbnail=await screen.findByRole('button',{name:'Enlarge Queued screenshot'});
 fireEvent.click(thumbnail);
 await waitFor(()=>expect(screen.getByRole('dialog',{name:'Queued screenshot'})).toBeVisible());
});

test('short queued text offers expansion when narrow wrapping exceeds three rendered lines',()=>{
 vi.spyOn(HTMLElement.prototype,'scrollHeight','get').mockReturnValue(100);
 vi.spyOn(HTMLElement.prototype,'clientHeight','get').mockReturnValue(60);
 const task={...fixtureTask(),queuedPrompts:[{id:'short',text:'A short request that wraps on a narrow screen.',images:[]}]};
 render(<MantineProvider><QueuedPrompts task={task}/></MantineProvider>);
 expect(screen.getByRole('button',{name:'Show more…'})).toBeVisible();
 fireEvent.click(screen.getByRole('button',{name:'Show more…'}));
 expect(screen.getByRole('button',{name:'Show less'})).toHaveAttribute('aria-expanded','true');
});
