import { expect, it } from 'bun:test';
import { connectPopupBackground } from '../../../src/entrypoints/popup/backgroundConnection';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function event<T extends (...args: any[]) => void>() {
    const listeners = new Set<T>();
    return {
        addListener: (listener: T) => { listeners.add(listener); },
        removeListener: (listener: T) => { listeners.delete(listener); },
        emit: (...args: Parameters<T>) => { for (const listener of [...listeners]) listener(...args); },
        listeners,
    };
}
function setup(failFirst = false) {
    const ports: ReturnType<typeof makePort>[] = [];
    const fallbacks: ((response: any) => void)[] = [];
    const messages: any[] = [];
    let attempts = 0;
    let disconnects = 0;
    let errorReads = 0;
    function makePort() {
        const onMessage = event<(message: any) => void>();
        const onDisconnect = event<() => void>();
        return { onMessage, onDisconnect, disconnect: () => onDisconnect.emit() };
    }
    const runtime = {
        connect: () => {
            attempts++;
            if (failFirst && attempts === 1) throw new Error('background unavailable');
            const port = makePort();
            ports.push(port);
            return port;
        },
        sendMessage: (_message: any, callback: (response: any) => void) => { fallbacks.push(callback); },
        get lastError() { errorReads++; return undefined; },
    };
    const stop = connectPopupBackground(runtime as unknown as Parameters<typeof connectPopupBackground>[0], message => messages.push(message), () => { disconnects++; });
    return { ports, fallbacks, messages, stop, attempts: () => attempts, disconnects: () => disconnects, errorReads: () => errorReads };
}

it('reconnects, resynchronizes state and ignores messages from the lost port', async () => {
    const s = setup();
    try {
        const lateMessage = [...s.ports[0].onMessage.listeners][0];
        s.ports[0].onDisconnect.emit();
        expect(s.disconnects()).toBe(1);
        expect(s.errorReads()).toBe(1);
        await sleep(550);
        expect(s.ports).toHaveLength(2);
        s.ports[1].onMessage.emit({ type: 'initialState', state: 'fresh' });
        lateMessage({ type: 'initialState', state: 'stale' });
        expect(s.messages).toEqual([{ type: 'initialState', state: 'fresh' }]);
    } finally { s.stop(); }
});

it('disposal removes listeners and cancels an outstanding reconnect', async () => {
    const s = setup();
    s.ports[0].onDisconnect.emit();
    s.stop();
    await sleep(550);
    expect(s.attempts()).toBe(1);
    expect(s.ports[0].onMessage.listeners.size).toBe(0);
    expect(s.ports[0].onDisconnect.listeners.size).toBe(0);
    expect(s.disconnects()).toBe(1);
});

it('intentional close does not invoke the disconnected callback', () => {
    const s = setup();
    s.stop();
    expect(s.disconnects()).toBe(0);
});

it('rejects a late fallback reply after reconnect and after disposal', async () => {
    const s = setup();
    try {
        await sleep(2050);
        expect(s.fallbacks).toHaveLength(1);
        s.ports[0].onDisconnect.emit();
        await sleep(550);
        s.fallbacks[0]({ state: 'stale' });
        s.ports[1].onMessage.emit({ type: 'initialState', state: 'fresh' });
        s.stop();
        s.fallbacks[0]({ state: 'after-close' });
        expect(s.messages).toEqual([{ type: 'initialState', state: 'fresh' }]);
    } finally { s.stop(); }
});

it('recovers if connecting initially throws', async () => {
    const s = setup(true);
    try {
        await sleep(550);
        expect(s.attempts()).toBe(2);
        expect(s.ports).toHaveLength(1);
        s.ports[0].onMessage.emit({ type: 'initialState' });
        expect(s.messages).toEqual([{ type: 'initialState' }]);
    } finally { s.stop(); }
});
