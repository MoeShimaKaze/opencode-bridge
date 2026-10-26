import { expect, it, vi } from 'vitest';
const lifecycle=vi.hoisted(()=>({start:vi.fn(),stop:vi.fn()}));
vi.mock('../src/index.js',()=>({startBridge:lifecycle.start,stopBridge:lifecycle.stop}));
import { BridgeManager } from '../src/admin/bridge-manager.js';
it('stops the shared lifecycle owner so an embedded restart can create a new instance',async()=>{
  const controllerStop=vi.fn();lifecycle.start.mockResolvedValue({stop:controllerStop});lifecycle.stop.mockResolvedValue(undefined);
  const manager=new BridgeManager(true);await manager.start();await manager.stop();
  expect(lifecycle.stop).toHaveBeenCalledTimes(1);expect(manager.getStatus().running).toBe(false);
});
