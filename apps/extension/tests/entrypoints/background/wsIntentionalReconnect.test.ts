import { expect, it, jest } from 'bun:test';
import { WebSocketManager } from '../../../src/entrypoints/background/webSocketManager';

it('manual reconnect detaches synchronous/late closes; unexpected current closes retain backoff', async () => {
    const originalTimeout=globalThis.setTimeout, originalClear=globalThis.clearTimeout;
    let nextId=0;
    const timers=new Map<number,{callback:()=>unknown;delay:number}>();
    globalThis.setTimeout=((callback:()=>unknown,delay:number)=>{const id=++nextId;timers.set(id,{callback,delay});return id;}) as any;
    globalThis.clearTimeout=((id:number)=>{timers.delete(id);}) as any;
    const clients:any[]=[];
    const session={session_id:'sign-retained',proposer_id:'other'};
    const state:any={deviceId:'test-device',wsConnected:true,sessionInfo:session};
    const status=jest.fn();
    const manager:any=new WebSocketManager(state,{updateWebSocketClient:jest.fn()} as any,jest.fn(),async()=>({success:true}),{updateWebSocketStatus:status,getState:()=>state});
    // Keep the production handler registration and reconnect state machine.
    // Only replace socket construction, so disconnect can synchronously close.
    manager.initialize=async()=>{
        const handlers:Record<string,Function>={};
        const client:any={handlers,live:true,onOpen:(cb:Function)=>handlers.open=cb,onClose:(cb:Function)=>handlers.close=cb,onError:(cb:Function)=>handlers.error=cb,onMessage:(cb:Function)=>handlers.message=cb,register:jest.fn(),sendSessionStatusUpdate:jest.fn(),listdevices:jest.fn(),requestActiveSessions:jest.fn(),getReadyState:()=>1,disconnect:()=>{client.live=false;handlers.close({code:1000,reason:'intentional'});}};
        clients.push(client);manager.wsClient=client;manager.setupEventHandlers();
    };
    try {
        await chrome.storage.local.set({deviceId:'test-device',signalRoom:'test-room-123456789'});
        await manager.initialize();
        // A pending unexpected-close retry must be cleared by a manual reconnect.
        manager.scheduleReconnect();expect(timers.size).toBe(1);
        await manager.reconnect();
        expect(timers.size).toBe(0);expect(state.wsConnected).toBe(false);
        expect(clients.filter(c=>c.live)).toHaveLength(1);
        clients[1].handlers.open();expect(state.wsConnected).toBe(true);
        timers.clear(); // Peer-list/discovery timers are unrelated to retries.
        await manager.reconnect();
        expect(timers.size).toBe(0);expect(clients.filter(c=>c.live)).toHaveLength(1);
        clients[2].handlers.open();timers.clear();
        const statusCount=status.mock.calls.length;
        clients[0].handlers.close({code:1006,reason:'late'});
        clients[1].handlers.close({code:1006,reason:'late'});
        expect(state.wsConnected).toBe(true);expect(timers.size).toBe(0);
        expect(status).toHaveBeenCalledTimes(statusCount);
        expect(state.sessionInfo).toBe(session);
        clients[2].handlers.close({code:1006,reason:'unexpected'});
        expect(state.wsConnected).toBe(false);expect(timers.size).toBe(1);
        const first=[...timers.values()][0]!;expect(first.delay).toBeGreaterThanOrEqual(500);expect(first.delay).toBeLessThanOrEqual(1000);
        // Execute the actual retry callback without real time passing.
        timers.clear();await first.callback();
        expect(clients).toHaveLength(4);expect(timers.size).toBe(0);
        clients[3].handlers.close({code:1006,reason:'still offline'});
        const second=[...timers.values()][0]!;expect(second.delay).toBeGreaterThanOrEqual(1000);expect(second.delay).toBeLessThanOrEqual(2000);
        expect(state.sessionInfo).toBe(session);
    } finally {globalThis.setTimeout=originalTimeout;globalThis.clearTimeout=originalClear;}
});
