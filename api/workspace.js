const { Sandbox } = require('@vercel/sandbox');
const crypto = require('node:crypto');

const TEAM_ID = process.env.VERCEL_TEAM_ID;
const PROJECT_ID = process.env.VERCEL_PROJECT_ID;
const ROOT = '/vercel/workspace';
const TEMPLATE_SNAPSHOT_ID = process.env.ZOSHIT_TEMPLATE_SNAPSHOT_ID || '';
const ALLOWED_HOSTS = [
  'services.gradle.org','downloads.gradle.org','repo.maven.apache.org','plugins.gradle.org',
  'maven.fabricmc.net','maven.minecraftforge.net','maven.neoforged.net','api.modrinth.com',
  'cdn.modrinth.com','github.com','objects.githubusercontent.com','raw.githubusercontent.com',
  'jitpack.io','libraries.minecraft.net','files.minecraftforge.net','maven.architectury.dev',
  'maven.shedaniel.me','maven.terraformersmc.com','maven.parchmentmc.org','maven.quiltmc.org',
  'archive.ubuntu.com','security.ubuntu.com','ports.ubuntu.com','azure.archive.ubuntu.com'
];

async function identify(req) {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) throw Object.assign(new Error('Увійди в акаунт, щоб відкрити робоче середовище.'), { status: 401 });
  let subject = '';
  if (token.split('.').length === 3) {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    if (!clientId) throw Object.assign(new Error('Google-вхід ще не налаштовано.'), { status: 503 });
    const r = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(token));
    const claims = await r.json();
    if (!r.ok || claims.aud !== clientId || !claims.sub || claims.email_verified !== 'true' || Number(claims.exp) * 1000 < Date.now()) {
      throw Object.assign(new Error('Сесія Google завершилась. Увійди знову.'), { status: 401 });
    }
    subject = 'google:' + claims.sub;
  } else {
    const r = await fetch('https://enter.pollinations.ai/api/oauth/userinfo', { headers: { authorization: 'Bearer ' + token } });
    if (!r.ok) throw Object.assign(new Error('Сесія входу завершилась. Увійди знову.'), { status: 401 });
    const user = await r.json();
    if (!user.sub) throw Object.assign(new Error('Не вдалося підтвердити акаунт.'), { status: 401 });
    subject = 'pollinations:' + user.sub;
  }
  return crypto.createHash('sha256').update(subject).digest('hex').slice(0, 24);
}

async function getBox(userHash) {
  const name = 'zoshit-u-' + userHash;
  try {
    const box = await Sandbox.get({ name });
    await box.runCommand('mkdir', ['-p', ROOT]);
    return box;
  } catch (e) {
    const opts = {
      name,
      persistent: true,
      timeout: 30 * 60 * 1000,
      resources: { vcpus: 2, memory: 4096 },
      networkPolicy: { mode: 'custom', allowedDomains: ALLOWED_HOSTS }
    };
    let box = null;
    if (TEMPLATE_SNAPSHOT_ID) {
      try { box = await Sandbox.create({ ...opts, source: { type:'snapshot', snapshotId:TEMPLATE_SNAPSHOT_ID } }); } catch {}
    }
    if (!box) box = await Sandbox.create({ ...opts, image:'vercel/sandbox/node:22' });
    await box.runCommand('mkdir', ['-p', ROOT]);
    const marker = ROOT + '/.zoshit-java-ready';
    try { await box.fs.stat(marker); }
    catch {
      const install = await box.runCommand({
        cmd: 'sh',
        args: ['-lc', "sed -i 's|http://archive.ubuntu.com|https://archive.ubuntu.com|g; s|http://security.ubuntu.com|https://security.ubuntu.com|g' /etc/apt/sources.list.d/ubuntu.sources && apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq openjdk-21-jdk-headless unzip zip git && java -version"],
        sudo: true,
        timeoutMs: 180000
      });
      if (install.exitCode !== 0) throw new Error('Не вдалося підготувати Java: ' + (await install.stderr()).slice(-1200));
      await box.fs.writeFile(marker, 'ready');
    }
    return box;
  }
}

function safePath(input) {
  const p = String(input || '').replace(/\\\\/g, '/').replace(/^\\/+/, '');
  if (!p || p.includes('..') || p.includes('\0') || p.startsWith('.zoshit')) throw Object.assign(new Error('Некоректний шлях.'), { status: 400 });
  return ROOT + '/' + p;
}

async function output(result) {
  return { exitCode: result.exitCode, stdout: (await result.stdout()).slice(-12000), stderr: (await result.stderr()).slice(-12000) };
}

module.exports = async (req, res) => {
  if (!['GET','POST'].includes(req.method)) return res.status(405).end();
  try {
    const userHash = await identify(req);
    const box = await getBox(userHash);
    const action = req.method === 'GET' ? 'list' : String(req.body?.action || '');

    if (action === 'list') {
      const r = await box.runCommand('sh', ['-lc', "cd " + ROOT + " && find . -type f -not -path './.gradle/*' -printf '%P\\t%s\\n' | head -200; du -sb . | cut -f1"]);
      const lines = (await r.stdout()).trim().split('\\n');
      const bytes = Number(lines.pop()) || 0;
      const files = lines.filter(Boolean).map(line => { const i=line.lastIndexOf('\\t'); return { path:line.slice(0,i), size:Number(line.slice(i+1))||0 }; });
      return res.json({ files, bytes, limitBytes: 500 * 1024 * 1024 });
    }

    if (action === 'upload-chunk') {
      const uploadId = String(req.body?.uploadId || '');
      const name = String(req.body?.name || '').split(/[\\\\/]/).pop();
      const index = Number(req.body?.index), total = Number(req.body?.total);
      const data = String(req.body?.data || '');
      if (!/^[a-f0-9]{24}$/.test(uploadId) || !name || name.length > 180 || !/^[a-zA-Z0-9._ ()@+-]+$/.test(name) || !Number.isInteger(index) || !Number.isInteger(total) || total < 1 || total > 50 || index < 0 || index >= total) {
        return res.status(400).json({ error:'Некоректні параметри завантаження.' });
      }
      const chunk = Buffer.from(data, 'base64');
      if (chunk.length > 2 * 1024 * 1024) return res.status(413).json({ error:'Розмір частини завеликий.' });
      const dir = ROOT + '/.uploads/' + uploadId;
      await box.fs.mkdir(dir, { recursive:true });
      await box.fs.writeFile(dir + '/' + String(index).padStart(4,'0') + '.part', chunk);
      if (index !== total - 1) return res.json({ ok:true, received:index+1, total, complete:false });
      const dest = ROOT + '/' + name;
      const assembled = await box.runCommand('sh', ['-lc', "cat '" + dir + "'/*.part > '" + dest + "' && rm -rf '" + dir + "'"]);
      if (assembled.exitCode !== 0) return res.status(500).json({ error:'Не вдалося зібрати файл із частин.' });
      if (name.toLowerCase().endsWith('.zip')) {
        const temp = '/tmp/zoshit-unpack-' + uploadId;
        const unpack = await box.runCommand('sh', ['-lc', "mkdir -p '" + temp + "' && unzip -oq '" + dest + "' -d '" + temp + "' && du -sb '" + temp + "' | cut -f1"]);
        if (unpack.exitCode !== 0) { await box.runCommand('rm',['-rf',temp,dest]); return res.status(400).json({ error:'ZIP не вдалося розпакувати: ' + (await unpack.stderr()).slice(-800) }); }
        const unpackedBytes = Number((await unpack.stdout()).trim()) || 0;
        const current = await box.runCommand('du',['-sb',ROOT]);
        const currentBytes = Number((await current.stdout()).trim().split(/\\s+/)[0]) || 0;
        if (currentBytes + unpackedBytes > 500 * 1024 * 1024) {
          await box.runCommand('rm',['-rf',temp,dest]);
          return res.status(413).json({ error:'У середовищі ліміт 500 МБ. Видали старі файли та спробуй ще раз.' });
        }
        const copy = await box.runCommand('sh',['-lc',"cp -a '" + temp + "'/. '" + ROOT + "'/ && rm -rf '" + temp + "'"]);
        if (copy.exitCode !== 0) return res.status(500).json({ error:'Не вдалося розпакувати проєкт у робочу папку.' });
      } else {
        const usage = await box.runCommand('du',['-sb',ROOT]);
        const bytes = Number((await usage.stdout()).trim().split(/\\s+/)[0]) || 0;
        if (bytes > 500 * 1024 * 1024) {
          await box.fs.rm(dest,{force:true});
          return res.status(413).json({ error:'У середовищі ліміт 500 МБ. Видали старі файли та спробуй ще раз.' });
        }
      }
      return res.json({ ok:true, received:total, total, complete:true, message:'Файл завантажено.' });
    }

    if (action === 'upload') {
      const files = Array.isArray(req.body?.files) ? req.body.files : [];
      if (!files.length || files.length > 30) return res.status(400).json({ error:'Додай від 1 до 30 файлів.' });
      let total = 0;
      for (const file of files) {
        const name = String(file.name || '').split(/[\\/]/).pop();
        const data = String(file.data || '');
        if (!name || name.length > 180 || !/^[a-zA-Z0-9._ ()@+-]+$/.test(name)) return res.status(400).json({ error:'Некоректна назва файлу.' });
        const buffer = Buffer.from(data, 'base64'); total += buffer.length;
        if (buffer.length > 12*1024*1024 || total > 24*1024*1024) return res.status(413).json({ error:'Ліміт завантаження — 24 МБ за раз.' });
        await box.writeFiles([{ path: ROOT + '/' + name, content: buffer }]);
        if (name.toLowerCase().endsWith('.zip')) {
          const unzip = await box.runCommand('unzip', ['-oq', ROOT + '/' + name, '-d', ROOT], { timeoutMs: 60000 });
          if (unzip.exitCode !== 0) return res.status(400).json({ error:'ZIP не вдалося розпакувати: ' + (await unzip.stderr()).slice(-800) });
        }
      }
      return res.json({ ok:true, message:'Файли завантажено.' });
    }

    if (action === 'delete') {
      const p = safePath(req.body?.path);
      await box.fs.rm(p, { recursive:true, force:true });
      return res.json({ ok:true });
    }

    if (action === 'clear') {
      await box.runCommand('sh', ['-lc', "find " + ROOT + " -mindepth 1 -maxdepth 1 ! -name '.zoshit-java-ready' -exec rm -rf -- {} +"]);
      return res.json({ ok:true });
    }

    if (action === 'build') {
      const detect = await box.runCommand('sh', ['-lc', "cd " + ROOT + " && if [ -f gradlew ]; then chmod +x gradlew; echo gradle-wrapper; elif [ -f build.gradle ] || [ -f build.gradle.kts ]; then echo gradle; elif [ -f mvnw ]; then chmod +x mvnw; echo maven-wrapper; elif [ -f pom.xml ]; then echo maven; elif [ -f package.json ]; then echo npm; else echo unknown; fi"]);
      const type = (await detect.stdout()).trim();
      const commands = {
        'gradle-wrapper':['sh',['-lc','cd '+ROOT+' && ./gradlew build --no-daemon']],
        'gradle':['gradle',['build','--no-daemon']],
        'maven-wrapper':['sh',['-lc','cd '+ROOT+' && ./mvnw package -DskipTests']],
        'maven':['mvn',['-f',ROOT+'/pom.xml','package','-DskipTests']],
        'npm':['sh',['-lc','cd '+ROOT+' && npm install && npm run build']]
      };
      if (!commands[type]) return res.status(400).json({ error:'Не знайшов Gradle, Maven або npm проєкт. Завантаж ZIP із файлами проєкту.' });
      const [cmd,args] = commands[type];
      const job = await box.runCommand({ cmd, args, cwd:ROOT, detached:true, timeoutMs:20*60*1000 });
      await box.fs.writeFile(ROOT+'/.zoshit-active-job.json', JSON.stringify({cmdId:job.cmdId,type,startedAt:Date.now()}));
      return res.json({ ok:true, jobId:job.cmdId, type, message:'Збірку запущено.' });
    }

    if (action === 'status') {
      const raw = await box.fs.readFile(ROOT+'/.zoshit-active-job.json','utf8').catch(()=>null);
      if (!raw) return res.json({ running:false, message:'Активних збірок немає.' });
      const job = JSON.parse(raw);
      try {
        const command = await box.getCommand(job.cmdId);
        const logs = [];
        const iterator = command.logs();
        const first = await Promise.race([iterator.next(), new Promise(resolve=>setTimeout(()=>resolve(null),900))]);
        if (first?.value?.data) logs.push(first.value.data);
        const running = command.exitCode === undefined || command.exitCode === null;
        return res.json({ running, jobId:job.cmdId, type:job.type, exitCode:command.exitCode ?? null, logs:logs.join('').slice(-6000) });
      } catch {
        return res.json({ running:false, jobId:job.cmdId, message:'Стан збірки більше недоступний. Перевір папку build.' });
      }
    }

    if (action === 'cancel') {
      const raw = await box.fs.readFile(ROOT+'/.zoshit-active-job.json','utf8').catch(()=>null);
      if (!raw) return res.json({ ok:true, message:'Активної збірки немає.' });
      const job = JSON.parse(raw);
      const command = await box.getCommand(job.cmdId);
      await command.kill('SIGTERM');
      await box.fs.rm(ROOT+'/.zoshit-active-job.json',{force:true});
      return res.json({ ok:true, message:'Збірку скасовано.' });
    }

    if (action === 'download') {
      const p = safePath(req.body?.path);
      const stat = await box.fs.stat(p);
      if (!stat.isFile() || stat.size > 40*1024*1024) return res.status(400).json({ error:'Файл не знайдено або він завеликий для завантаження.' });
      const data = await box.fs.readFile(p);
      res.setHeader('content-type','application/octet-stream');
      res.setHeader('content-disposition','attachment; filename="'+p.split('/').pop().replace(/["\\\\]/g,'_')+'"');
      return res.status(200).send(data);
    }

    if (action === 'stop') {
      await box.stop();
      return res.json({ ok:true, message:'Середовище зупинено; файли збережені.' });
    }
    return res.status(400).json({ error:'Невідома дія.' });
  } catch (e) {
    return res.status(e.status || 500).json({ error:String(e.message || e).slice(0,1000) });
  }
};
