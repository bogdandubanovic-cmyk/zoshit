// Agent chat proxy: model routing + optional Pollinations MCP tools.
module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'Підключи ШІ, щоб почати чат.' });

  const { messages = [], memory = [] } = req.body || {};
  if (!Array.isArray(messages) || messages.length > 20 || !Array.isArray(memory)) {
    return res.status(400).json({ error: 'Некоректний запит' });
  }

  const lastUser = [...messages].reverse().find(m => m && m.role === 'user');
  const userText = typeof lastUser?.content === 'string'
    ? lastUser.content
    : Array.isArray(lastUser?.content)
      ? lastUser.content.filter(p => p.type === 'text').map(p => p.text || '').join(' ')
      : '';
  const wantsCode = /(код|code|сайт|сайта|сайту|програм|html|css|javascript|typescript|python|react|next\.js|верст|debug|помилк|запусти|тест)/i.test(userText);
  const wantsWeb = /(інтернет|веб|пошук|знайди|знайти|пошукай|актуальн|сьогодні|зараз|останні|новини|джерел|посилан|ціна|порівняй|досліди|research|search|website|сайт)/i.test(userText);

  const system = [
    'Ти — «Зошит», сильний універсальний ШІ-асистент. Спілкуйся природно, живо й адаптуйся до стилю користувача, але не копіюй грубість.',
    'Головна мета — правильно зрозуміти намір з першого разу. Не чіпляйся до окремих слів: враховуй весь контекст і попередні повідомлення. Якщо запит зрозумілий — одразу виконуй. Якщо критично бракує однієї деталі — постав одне коротке уточнення.',
    'Відповідай мовою користувача. Не вигадуй виконані дії, джерела, посилання, результати тестів або можливості. Чітко кажи, що реально зроблено, а що ні.',
    'Для програмування поводься як досвідчений senior engineer: спершу зрозумій мету й наявний стек, потім пропонуй сучасне, чисте, доступне та адаптивне рішення. Пиши повний робочий код, а не псевдокод; враховуй мобільні екрани, стани помилок, безпеку, продуктивність і доступність. Не вигадуй API та бібліотеки. Пояснюй запуск і перевірку коротко.',
    'Якщо доступні веб-інструменти, шукай актуальну інформацію ними, відкривай першоджерела за потреби та додавай посилання. Не заявляй про доступ до всього інтернету — доступ обмежений публічними сторінками та інструментами.',
    'Якщо доступний ізольований комп’ютер, використовуй його лише для безпечного тестування або створення тимчасових прикладів. Не виконуй руйнівні команди, не читай секрети, не змінюй зовнішні акаунти й не публікуй зміни без прямого прохання користувача.',
    'Для GitHub, Vercel та інших акаунтів пояснюй, коли потрібне окреме підключення користувача. Ніколи не проси вставляти секретні ключі в чат.',
    'Форматуй відповіді Markdown: зрозумілі заголовки, списки та блоки коду. Уникай зайвих зірочок і декоративного форматування.'
  ].join('\\n\\n') +
    (memory.length ? '\\n\\nКонтекст попередніх запитів користувача:\\n- ' + memory.slice(-20).map(x => String(x).slice(0, 300)).join('\\n- ') : '');

  async function mcp(server, method, params = {}, id = 1, session) {
    const headers = {
      'content-type': 'application/json',
      'accept': 'application/json, text/event-stream',
      'authorization': 'Bearer ' + token
    };
    if (session) headers['mcp-session-id'] = session;
    if (method !== 'initialize') headers['mcp-protocol-version'] = '2025-03-26';
    const packet = { jsonrpc: '2.0', method, params };
    if (!method.startsWith('notifications/')) packet.id = id;
    const r = await fetch('https://gen.pollinations.ai/mcp/' + server, {
      method: 'POST', headers,
      body: JSON.stringify(packet)
    });
    const sessionId = r.headers.get('mcp-session-id') || session || null;
    const raw = await r.text();
    if (!r.ok) throw new Error('MCP ' + server + ': HTTP ' + r.status + ' ' + raw.slice(0, 180));
    if (method === 'notifications/initialized') return { sessionId };
    let payload = null;
    try { payload = JSON.parse(raw); } catch {
      const events = raw.split(/\\r?\\n/).filter(x => x.startsWith('data:')).map(x => x.slice(5).trim());
      for (const event of events.reverse()) { try { payload = JSON.parse(event); break; } catch {} }
    }
    if (payload?.error) throw new Error(payload.error.message || 'MCP request failed');
    return { payload, sessionId };
  }

  async function connectMcp(server) {
    const init = await mcp(server, 'initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'zoshit', version: '1.1.0' }
    });
    const sid = init.sessionId;
    await mcp(server, 'notifications/initialized', {}, 0, sid);
    const listed = await mcp(server, 'tools/list', {}, 2, sid);
    return { sid, tools: listed.payload?.result?.tools || [] };
  }

  try {
    const converted = messages.slice(-18).map(m => {
      let content = m.content;
      if (Array.isArray(content)) {
        content = content.map(p => {
          if (p.type === 'text') return { type: 'text', text: String(p.text || '').slice(0, 30000) };
          if (p.type === 'image' && p.source?.type === 'base64') {
            return { type: 'image_url', image_url: { url: 'data:' + p.source.media_type + ';base64,' + p.source.data } };
          }
          if (p.type === 'document') return { type: 'text', text: '[PDF додано; якщо модель не підтримує PDF, попроси користувача надіслати фото сторінок або текст.]' };
          return { type: 'text', text: '' };
        });
      }
      return { role: m.role === 'assistant' ? 'assistant' : 'user', content };
    });

    const toolMap = {};
    const tools = [];
    if (wantsWeb) {
      try {
        const exa = await connectMcp('exa');
        for (const t of exa.tools) {
          if (!['web_search_exa', 'web_fetch_exa'].includes(t.name)) continue;
          toolMap[t.name] = { server: 'exa', sid: exa.sid };
          tools.push({ type: 'function', function: {
            name: t.name,
            description: String(t.description || '').slice(0, 900),
            parameters: t.inputSchema || { type: 'object', properties: {} }
          }});
        }
      } catch (e) { /* Search remains optional if this user's key lacks MCP access. */ }
    }
    if (wantsCode) {
      try {
        const computer = await connectMcp('computer');
        for (const t of computer.tools) {
          if (!['bash', 'javascript'].includes(t.name)) continue;
          toolMap[t.name] = { server: 'computer', sid: computer.sid };
          tools.push({ type: 'function', function: {
            name: t.name,
            description: 'Ізольоване середовище користувача. ' + String(t.description || '').slice(0, 700) + ' Використовуй лише для нешкідливого тестування коду; не запускай руйнівні команди та не читай секрети.',
            parameters: t.inputSchema || { type: 'object', properties: {} }
          }});
        }
      } catch (e) { /* Coding help still works without a sandbox. */ }
    }

    // Prefer a stronger reasoning-capable model; Pollinations applies the user's key permissions and budget.
    const preferredModels = 'openai/gpt-6-sol,anthropic/claude-sonnet-5.5,openai/gpt-5.5,openai/gpt-5.4';
    const body = {
      model: preferredModels,
      reasoning_effort: 'high',
      messages: [{ role: 'system', content: system }, ...converted],
      max_tokens: 5000
    };
    if (tools.length) body.tools = tools;

    let finalText = '';
    for (let step = 0; step < 4; step++) {
      const r = await fetch('https://gen.pollinations.ai/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
        body: JSON.stringify(body)
      });
      const d = await r.json();
      if (!r.ok) return res.status(r.status).json({
        error: r.status === 402
          ? 'На акаунті ШІ закінчився доступний баланс або ліміт. Перевір витрати в Pollinations.'
          : (d.error?.message || d.message || 'Помилка сервісу ШІ')
      });
      const message = d.choices?.[0]?.message;
      const calls = message?.tool_calls || [];
      if (!calls.length) {
        const answer = message?.content;
        finalText = Array.isArray(answer) ? answer.map(x => x.text || '').join('') : (answer || '');
        break;
      }
      body.messages.push({
        role: 'assistant',
        content: message.content || null,
        tool_calls: calls
      });
      for (const call of calls) {
        const name = call.function?.name;
        const entry = toolMap[name];
        if (!entry) {
          body.messages.push({ role: 'tool', tool_call_id: call.id, content: 'Інструмент недоступний.' });
          continue;
        }
        let args = {};
        try { args = JSON.parse(call.function.arguments || '{}'); } catch {}
        try {
          const result = await mcp(entry.server, 'tools/call', { name, arguments: args }, 10 + step, entry.sid);
          const content = result.payload?.result?.content || [];
          const output = content.map(x => x.text || '').join('\\n').slice(0, 18000) ||
            JSON.stringify(result.payload?.result || {}).slice(0, 18000);
          body.messages.push({ role: 'tool', tool_call_id: call.id, content: output || 'Інструмент виконано без текстового результату.' });
        } catch (e) {
          body.messages.push({ role: 'tool', tool_call_id: call.id, content: 'Помилка інструмента: ' + String(e.message || e).slice(0, 500) });
        }
      }
    }
    return res.json({ text: finalText || 'Не вдалося отримати завершену відповідь. Спробуй ще раз.' });
  } catch (e) {
    return res.status(502).json({ error: 'Не вдалося зв’язатися із сервісом ШІ: ' + String(e.message || e).slice(0, 220) });
  }
};
