import { MESSAGE_PREFIX, MessageType } from '../../constants';
import type {
    ContentToBackgroundMsg,
    BackgroundToContentMsg,
    InjectedToContentMsg,
    ContentToInjectedMsg,
    JsonRpcRequest,
    JsonRpcResponse
} from "@stars-labs/types/messages";

// 定义消息接口
export interface ContentMessage {
    type: string;
    payload: JsonRpcRequest | JsonRpcResponse;
}

export class ContentProvider {

    constructor() {
        // 监听来自页面的消息
        window.addEventListener('message', this.handlePageMessage);

        // 监听来自扩展的消息
        chrome.runtime.onMessage.addListener(this.handleExtensionMessage);
    }

    // 处理来自页面的消息
    private handlePageMessage = (event: MessageEvent) => {
        // 忽略来自其他源的消息
        if (event.source !== window) return;

        try {
            const data = event.data as InjectedToContentMsg;
            
            // Debug the received message
            console.log('[Content Script] Received message from page:', data);

            // 检查消息是否来自我们的注入脚本
            if (data && typeof data === 'object' && data.type === `${MESSAGE_PREFIX}${MessageType.REQUEST}`) {
                // 解析请求
                const request = data.payload as JsonRpcRequest;
                console.log(`[Content Script] Processing request: ${request.method}`, request);
                
                // Always forward to background for proper permission handling
                // The background script will check permissions and return appropriate accounts
                this.forwardToBackground(request);
            }
        } catch (err) {
            console.error('[Content Script] Error handling page message:', err);
        }
    };

    // 处理来自扩展的消息
    private handleExtensionMessage = (
        message: BackgroundToContentMsg,
        sender: chrome.runtime.MessageSender,
        sendResponse: (response?: any) => void
    ) => {
        console.log('[Content Script] Received message from extension:', message);
        
        // 转发响应到页面
        if (message.type === 'REQUEST_RESPONSE' && message.payload) {
//             console.log('[Content Script] Forwarding RPC response to page:', message.payload);
            this.sendToPage({
                type: 'WALLET_RESPONSE',
                payload: message.payload
            });
            sendResponse({ received: true });
        } else if (message.type === 'GET_STATE') {
            // Return content script state information
            sendResponse({ active: true });
        } else if (message.type === 'SAVE_ADDRESS') {
            // Save address to storage for quick retrieval
            if (message.address && typeof message.address === 'string') {
                console.log('[Content Script] Saving address to storage:', message.address);
                chrome.storage.local.set({
                    ['mpc_' + (message.blockchain || 'ethereum') + '_address']: message.address
                }, () => {
                    sendResponse({ success: true });
                });
                return true; // Keep sendResponse valid
            }
        } else {
            console.log('[Content Script] Unknown message type:', message.type);
            sendResponse({ error: 'Unknown message type' });
        }
    };

    private forwardToBackground(request: JsonRpcRequest) {
        // The background routes any typed message whose payload is a JSON-RPC
        // request to the RpcHandler. It derives the origin from the sender
        // frame itself, so none is sent here.
        const message = {
            type: 'dappRpc',
            payload: request,
        };

//         console.log('[Content Script] Forwarding request to background:', request.method);
        chrome.runtime.sendMessage(message, (response) => {
            if (chrome.runtime.lastError) {
                console.error('[Content Script] Error forwarding request:', chrome.runtime.lastError);
                // Send error response to page
                this.sendToPage({
                    type: 'WALLET_RESPONSE',
                    payload: {
                        id: request.id,
                        jsonrpc: '2.0',
                        error: {
                            code: -32603,
                            message: 'Internal error: ' + chrome.runtime.lastError.message
                        }
                    }
                });
                return;
            }
            
            if (response) {
                console.log('[Content Script] Got direct response from background:', response);
                // If we got a direct response, use it
                let payload: JsonRpcResponse;
                
                if (response.success && 'result' in response) {
                    payload = {
                        id: request.id,
                        jsonrpc: '2.0',
                        result: response.result
                    };
                } else if (response.error) {
                    // Handle different error formats
                    let errorMessage = response.error;
                    let errorCode = -32603; // Default Internal Error code
                    
                    // Check if error is already an object with message
                    if (typeof response.error === 'object' && response.error !== null) {
                        errorMessage = response.error.message || JSON.stringify(response.error);
                        errorCode = response.error.code || errorCode;
                    }
                    
                    payload = {
                        id: request.id,
                        jsonrpc: '2.0',
                        error: {
                            code: errorCode,
                            message: errorMessage
                        }
                    };
                } else if (request.method === 'eth_requestAccounts' && response.data && Array.isArray(response.data)) {
                    // Special handling for eth_requestAccounts
                    payload = {
                        id: request.id,
                        jsonrpc: '2.0',
                        result: response.data
                    };
                } else {
                    // Default to just returning the full response as result
                    payload = {
                        id: request.id,
                        jsonrpc: '2.0',
                        result: response
                    };
                }
                
                this.sendToPage({
                    type: 'WALLET_RESPONSE',
                    payload
                });
            }
            // If no response, background will send it later via handleExtensionMessage
        });
    }

    private sendToPage(message: ContentToInjectedMsg) {
        window.postMessage({
            ...message,
            type: `${MESSAGE_PREFIX}${MessageType.RESPONSE}`
        }, '*');
    }

    public cleanup() {
        window.removeEventListener('message', this.handlePageMessage);
    }
}

export default new ContentProvider();
