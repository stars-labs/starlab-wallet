# Packaged token identity assets

Downloaded 4 October 2026. Native assets are local so the wallet does not send browsing or address information to an image host.

- SOL: official https://solana.com/src/img/branding/solanaLogoMark.svg ; guidelines https://solana.com/branding . Preserve geometry and gradient.
- BTC: https://github.com/BitcoinDesign/Guide/blob/master/assets/images/guide/getting-started/visual-language/bitcoin-symbol.svg (Bitcoin Design community).
- ETH, USDC, USDT, DAI, BNB, POL (MATIC mark), AVAX: https://github.com/spothq/cryptocurrency-icons/tree/master/svg/color (CC0 public-domain icon collection). File geometry retained; these are recognizable marks, not issuer-provided verification badges.
- SUI: https://github.com/trustwallet/assets/blob/master/blockchains/sui/info/logo.png (Trust Wallet asset repository, actual Sui droplet). Primary brand guidance: https://www.sui.io/blog/trademark-usage-reporting .

Curated ERC-20 marks only appear for the canonical chain ID and contract address in services/tokenService.ts. Arbitrary contracts with matching tickers receive a neutral monogram. Native identity comes from chain; no symbol-based trust inference. Different EVM network names must remain visible alongside common ETH identity. No claim of affiliation or endorsement.

- Base, Arbitrum and Optimism chain badges: https://github.com/trustwallet/assets/tree/master/blockchains/{base,arbitrum,optimism}/info/logo.png . Chain badges identify the network, independently from its native ETH token.
