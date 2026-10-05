/** Presentation fixtures only: no real signatures, refresh, key shares or RPCs. */
const address = '0x2fb6ae33558e46ec6baa39c9c98cd00f4b0f7548';
const participants = ['This browser', 'Desktop', 'Phone'];
const sessionId = 'public-refresh-fixture';

export const approvalCoverageLimits = [
  'dApp preflight warning: not applicable; SignatureRequest only renders a message and has no transaction simulation result.',
  'dApp rejected: capture proves the production request card is dismissed after rejection; no persistent rejected-result panel exists.',
  'Refresh screenshots use public FROST state fixtures; they do not prove share rotation or Ethereum device retirement.',
];

export function edgeScenario(mode) {
  if (['edge-dapp-unknown', 'edge-dapp-rejected', 'edge-dapp-busy', 'edge-dapp-error'].includes(mode)) {
    return {pendingMessages: mode === 'edge-dapp-busy' ? ['approveMessageSignature'] : [], responses: {
      getPendingSignatureRequests: {success: true, requests: [{
        signingId: 'public-edge-signature', origin: 'https://app.example.org', fromAddress: address,
        message: mode === 'edge-dapp-unknown' ? `0x${'0123456789abcdef'.repeat(16)}` : 'Sign in to Example app',
      }]},
      approveMessageSignature: mode === 'edge-dapp-error' ? {success: false, error: 'Signing failed. Unlock your wallet and try again.'} : {success: true},
    }};
  }
  const states = {
    'edge-refresh-waiting': null,
    'edge-refresh-round1': 'Round1InProgress',
    'edge-refresh-round2': 'Round2InProgress',
    'edge-refresh-failed': 'Failed',
    'edge-refresh-complete': 'Complete',
    'edge-refresh-save-failed': 'Complete',
  };
  if (!(mode in states)) return {};
  const state = states[mode];
  const reshareStatus = state ? {
    sessionId, walletId: 'public-demo-wallet', state, participants,
    round1Received: state === 'Round1InProgress' ? participants.slice(0, 2) : participants,
    round2Received: state === 'Round2InProgress' ? participants.slice(0, 1) : state === 'Complete' ? participants : [],
    error: state === 'Failed' ? 'A device disconnected. Reconnect all devices and try again.' : undefined,
    saved: state === 'Complete' && mode !== 'edge-refresh-save-failed', updatedAt: 1791108000000,
  } : undefined;
  return {responses: {createReshareSession: {success: true, sessionId}}, state: {
    sessionInfo: {session_id: sessionId, session_type: 'reshare', participants: state ? participants : participants.slice(0, 1), total: 3},
    reshareStatus,
  }};
}

export async function captureEdgeApprovals(capture) {
  for (const theme of ['light', 'dark']) {
    await capture(`dapp-unknown-${theme}`, 'edge-dapp-unknown', theme, 380, async page => {
      await page.getByText('View full message', {exact: true}).click();
      await page.getByText('Review signature', {exact: true}).waitFor();
    });
    await capture(`dapp-rejected-dismissed-${theme}`, 'edge-dapp-rejected', theme, 380, async page => {
      await page.getByRole('button', {name: 'Reject', exact: true}).click();
      await page.getByText('Review signature', {exact: true}).waitFor({state: 'hidden'});
    });
    await capture(`dapp-busy-${theme}`, 'edge-dapp-busy', theme, 380, async page => {
      await page.getByRole('button', {name: 'Sign', exact: true}).click();
      await page.getByRole('button', {name: 'Signing…', exact: true}).waitFor();
    });
    await capture(`dapp-error-${theme}`, 'edge-dapp-error', theme, 380, async page => {
      await page.getByRole('button', {name: 'Sign', exact: true}).click();
      await page.getByText('Signing failed. Unlock your wallet and try again.', {exact: true}).waitFor();
    });
    for (const phase of ['waiting', 'round1', 'round2', 'failed', 'complete', 'save-failed']) {
      await capture(`refresh-${phase}-${theme}`, `edge-refresh-${phase}`, theme, 380, async page => {
        await page.getByRole('button', {name: 'Settings', exact: true}).click();
        const card = page.getByTestId('reshare-card');
        await card.getByRole('button', {name: 'Rotate shares', exact: true}).click();
        await card.getByTestId('reshare-progress').waitFor();
        const expected = {
          waiting: /Waiting for devices to join/, round1: /Round 1 of 2/, round2: /Round 2 of 2/,
          failed: /A device disconnected/, complete: /new Bitcoin, Solana or Sui shares saved/,
          'save-failed': /saving the new share failed/,
        }[phase];
        await card.getByText(expected).waitFor();
      });
    }
  }
}
