/** Own the popup port and state resync for exactly one mounted UI. */
export function connectPopupBackground(
    runtime: Pick<typeof chrome.runtime, "connect" | "sendMessage" | "lastError">,
    onMessage: (message: any) => void,
    onDisconnected: () => void,
) {
    let stopped = false;
    let current: chrome.runtime.Port | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let fallback: ReturnType<typeof setTimeout> | undefined;
    let delay = 500;
    let detach: (() => void) | undefined;

    const reconnect = () => {
        if (stopped || retry) return;
        retry = setTimeout(() => {
            retry = undefined;
            connect();
        }, delay);
        delay = Math.min(delay * 2, 5000);
    };
    const connect = () => {
        if (stopped) return;
        let port: chrome.runtime.Port;
        try {
            port = runtime.connect({ name: "popup" });
        } catch {
            onDisconnected();
            reconnect();
            return;
        }
        current = port;
        let received = false;
        const receive = (message: any) => {
            if (stopped || current !== port) return;
            if (message.type === "initialState") {
                received = true;
                delay = 500;
                clearTimeout(fallback);
                fallback = undefined;
            }
            onMessage(message);
        };
        const disconnected = () => {
            // Consume Chrome's optional disconnect diagnostic.
            void runtime.lastError;
            if (stopped || current !== port) return;
            current = undefined;
            clearTimeout(fallback);
            fallback = undefined;
            detach?.();
            onDisconnected();
            reconnect();
        };
        detach = () => {
            port.onMessage.removeListener(receive);
            port.onDisconnect.removeListener(disconnected);
        };
        port.onMessage.addListener(receive);
        port.onDisconnect.addListener(disconnected);
        fallback = setTimeout(() => {
            fallback = undefined;
            if (stopped || current !== port || received) return;
            runtime.sendMessage({ type: "getState" }, (response: any) => {
                const error = runtime.lastError;
                if (!error && response && !received && !stopped && current === port) {
                    receive({ ...response, type: "initialState" });
                }
            });
        }, 2000);
    };
    connect();
    return () => {
        stopped = true;
        clearTimeout(retry);
        clearTimeout(fallback);
        detach?.();
        const port = current;
        current = undefined;
        port?.disconnect();
    };
}
