import type { HardwareAssertion } from './hardwareVault';

export type SecurityKeyAction = 'create' | 'unlock';
export const SECURITY_KEY_MESSAGES = {
    OPEN: 'openSecurityKeyAuth',
    GET_REQUEST: 'getSecurityKeyRequest',
    COMPLETE: 'completeSecurityKeyAuth',
    CANCEL: 'cancelSecurityKeyAuth',
} as const;

export type SecurityKeyMessage =
    | { type: typeof SECURITY_KEY_MESSAGES.OPEN; action: SecurityKeyAction }
    | { type: typeof SECURITY_KEY_MESSAGES.GET_REQUEST; requestId: string }
    | { type: typeof SECURITY_KEY_MESSAGES.COMPLETE; requestId: string; assertion: HardwareAssertion }
    | { type: typeof SECURITY_KEY_MESSAGES.CANCEL; requestId: string };

export interface SecurityKeyRequestInfo {
    success: true;
    action: SecurityKeyAction;
    credential?: { credentialId: string; prfSalt: string };
}

export interface SecurityKeyOpenResult {
    success: true;
    requestId: string;
    url: string;
    tabId: number;
}

export function isSecurityKeyMessage(message: { type: string }): boolean {
    return Object.values(SECURITY_KEY_MESSAGES).some(type => type === message.type);
}
