# Coin satın alma kurulumu

1. Cüzdan adreslerini yaz: `data/wallets.json` (ya da PAY_WALLETS ortam değişkeni):
   {"USDT":{"net":"TRC20","addr":"T..."},"BTC":{"net":"Bitcoin","addr":"bc1..."},"ETH":{"addr":"0x..."}}
   Adresi olmayan coin oyunda pasif görünür. Coinler: TRX BTC ETH BNB USDT LTC SOL XRP DOGE (hepsi aktif).
2. Talepleri owner hesabıyla gör: oyunda Admin paneli > "Bekleyen yatırımlar". TXID'yi blokzincirinde kontrol edip Onayla/Reddet.
3. Ayarlar (opsiyonel, ortam değişkeni): START_GOLD (varsayılan 100), DEP_MIN_USD (2), DEP_MAX_USD (500),
   DEP_DAY_USD (1000, günlük), TIP_MAX (2000), XFER_DAY (10000).
4. Kayıtlar data/deposits.json içinde (Upstash kullanıyorsan veritabanında) saklanır.
