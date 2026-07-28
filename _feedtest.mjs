import Parser from 'rss-parser';
const parser = new Parser({ timeout: 10000 });
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; AgentsSocietyNewsBot/1.0; +https://veii.ai)',
  Accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5',
};
function escapeBareAmpersands(xml) {
  const BARE_AMP = /&(?!(?:[a-zA-Z][a-zA-Z0-9]*|#\d+|#x[0-9a-fA-F]+);)/g;
  return xml.split(/(<!\[CDATA\[[\s\S]*?\]\]>)/)
    .map((c, i) => (i % 2 === 1 ? c : c.replace(BARE_AMP, '&amp;'))).join('');
}
const feeds = [
  ['RevOps Co-op', 'https://revopscoop.substack.com/feed'],
  ['GTMnow', 'https://gtmnow.com/feed/'],
  ['LangChain Blog', 'https://blog.langchain.com/rss/'],
  ['Content Marketing Institute', 'https://www.contentmarketinginstitute.com/feed/'],
];
for (const [name, url] of feeds) {
  // old behaviour
  let before;
  try { const f = await parser.parseURL(url); before = `OK (${f.items.length})`; }
  catch (e) { before = `FAIL: ${e.message.split('\n')[0]}`; }
  // new behaviour
  let after;
  try {
    const res = await fetch(url, { headers: HEADERS, redirect: 'follow' });
    if (!res.ok) throw new Error(`Status code ${res.status}`);
    const xml = await res.text();
    let f;
    try { f = await parser.parseString(xml); }
    catch (e) {
      if (!/entity|Invalid character/i.test(e.message)) throw e;
      f = await parser.parseString(escapeBareAmpersands(xml));
    }
    after = `OK (${f.items.length} items) — "${(f.items[0]?.title||'').slice(0,50)}"`;
  } catch (e) { after = `FAIL: ${e.message.split('\n')[0]}`; }
  console.log(`${name}\n   prima: ${before}\n   dopo : ${after}`);
}
