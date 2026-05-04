import YahooFinance from 'yahoo-finance2';
const yf = new YahooFinance();
try {
  const q = await yf.quote('TCS.NS');
  console.log('QUOTE OK - price:', q.regularMarketPrice, '| name:', q.longName, '| pe:', q.trailingPE, '| eps:', q.epsTrailingTwelveMonths);
} catch(e) { console.error('quote FAILED:', e.message.slice(0,200)); }

try {
  const s = await yf.quoteSummary('TCS.NS', { modules: ['assetProfile','summaryDetail','defaultKeyStatistics'] }, { validateResult: false });
  console.log('quoteSummary OK - CEO:', s.assetProfile?.companyOfficers?.[0]?.name, '| pe:', s.summaryDetail?.trailingPE);
} catch(e) { console.error('quoteSummary FAILED:', e.message.slice(0,200)); }

try {
  const s2 = await yf.quoteSummary('TCS.NS', { modules: ['assetProfile'] });
  console.log('quoteSummary strict OK - sector:', s2.assetProfile?.sector);
} catch(e) { console.error('quoteSummary strict FAILED:', e.message.slice(0,200)); }
