module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');

  if (!token) return res.status(401).json({ error: 'Підключи ШІ, щоб створювати зображення.' });
  const prompt = String((req.body || {}).prompt || '').trim();
  if (!prompt || prompt.length > 1200) return res.status(400).json({ error: 'Опиши зображення коротше (до 1200 символів).' });

  try {
    const url = 'https://gen.pollinations.ai/image/' + encodeURIComponent(prompt) +
      '?model=black-forest-labs/flux.1-schnell&width=1024&height=1024&nologo=true';
    const r = await fetch(url, { headers: { authorization: 'Bearer ' + token } });
    if (!r.ok) {
      const detail = await r.text();
      return res.status(r.status).json({
        error: r.status === 402
          ? 'Для генерації зображень потрібен доступний баланс/ліміт у Pollinations.'
          : r.status === 401
            ? 'Pollinations не прийняв авторизацію. Від’єднай акаунт і увійди знову.'
            : 'Не вдалося створити зображення: ' + detail.slice(0, 180)
      });
    }
    const link = r.headers.get('link') || '';
    const match = link.match(/<([^>]+)>;\s*rel="?enclosure"?/i);
    if (match) return res.status(200).json({ url: match[1] });
    const type = r.headers.get('content-type') || 'image/jpeg';
    const bytes = Buffer.from(await r.arrayBuffer());
    return res.status(200).json({ url: 'data:' + type + ';base64,' + bytes.toString('base64') });
  } catch {
    return res.status(502).json({ error: 'Помилка з’єднання із сервісом генерації зображень.' });
  }
};
