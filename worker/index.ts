
// Add missing D1 type definitions locally
interface D1Result<T = unknown> {
  results: T[];
  success: boolean;
  error?: string;
  meta: any;
}

interface D1PreparedStatement {
  bind(...values: any[]): D1PreparedStatement;
  first<T = unknown>(colName?: string): Promise<T | null>;
  run<T = unknown>(): Promise<D1Result<T>>;
  all<T = unknown>(): Promise<D1Result<T>>;
  raw<T = unknown>(): Promise<T[]>;
}

interface D1Database {
  prepare(query: string): D1PreparedStatement;
  dump(): Promise<ArrayBuffer>;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
  exec<T = unknown>(query: string): Promise<D1Result<T>>;
}

// Pages Advanced Mode 自动注入 ASSETS fetcher
interface Env {
  ASSETS: { fetch: (request: Request) => Promise<Response> };
  DB?: D1Database | string; // Handle misconfiguration case
  NAI_API_KEY: string;
  MASTER_KEY: string;
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Master-Key',
};

const json = (data: any, status = 200) => 
  new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json', ...corsHeaders }, status });

const error = (msg: string, status = 500) => 
  new Response(JSON.stringify({ error: msg }), { headers: { 'Content-Type': 'application/json', ...corsHeaders }, status });

// SQL Schema for Auto-Initialization
const INIT_SQL = `
  CREATE TABLE IF NOT EXISTS chains (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    tags TEXT,
    preview_image TEXT,
    created_at INTEGER,
    updated_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS versions (
    id TEXT PRIMARY KEY,
    chain_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    base_prompt TEXT,
    negative_prompt TEXT,
    modules TEXT,
    params TEXT,
    created_at INTEGER,
    FOREIGN KEY(chain_id) REFERENCES chains(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS artists (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    image_url TEXT
  );
  CREATE TABLE IF NOT EXISTS inspirations (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    image_url TEXT,
    prompt TEXT,
    created_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_versions_chain_id ON versions(chain_id);
`;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // 1. 如果不是 API 请求，直接返回静态资源 (Frontend)
    if (!path.startsWith('/api/')) {
      return env.ASSETS.fetch(request);
    }

    // 2. 处理 API CORS Preflight
    if (method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      // --- Auth Check (Admin Only Routes) ---
      if (['PUT', 'DELETE'].includes(method) || (path.startsWith('/api/artists') && method === 'POST') || (path.startsWith('/api/inspirations') && method === 'POST')) {
         const authHeader = request.headers.get('X-Master-Key');
         if (authHeader !== env.MASTER_KEY) {
           return error('Unauthorized', 401);
         }
      }
      
      // --- Auth Verification Endpoint ---
      if (path === '/api/verify-key' && method === 'POST') {
        const { key } = await request.json() as any;
        if (key === env.MASTER_KEY) return json({ success: true });
        return error('Invalid Key', 401);
      }

      // --- NovelAI Proxy ---
      if (path === '/api/generate' && method === 'POST') {
        const body = await request.json();
        const naiRes = await fetch("https://image.novelai.net/ai/generate-image", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${env.NAI_API_KEY}`
          },
          body: JSON.stringify(body)
        });

        if (!naiRes.ok) {
           const errText = await naiRes.text();
           return error(`NAI API Error: ${errText}`, naiRes.status);
        }
        
        const blob = await naiRes.blob();
        return new Response(blob, {
          headers: { ...corsHeaders, 'Content-Type': 'application/zip' }
        });
      }

      // --- Database Guard ---
      if (!env.DB) {
        return error('Database not configured. Please bind a D1 database named "DB".', 503);
      }

      // Critical Check: Prevent "db.prepare is not a function"
      // If the user adds DB="xxx" to [vars], env.DB becomes a string, breaking the app.
      if (typeof env.DB === 'string' || typeof (env.DB as any).prepare !== 'function') {
        return error('Configuration Error: "DB" variable is a string/invalid. Do NOT add "DB" to [vars] in wrangler.toml or Dashboard Environment Variables. It must be a D1 Binding only.', 500);
      }

      const db = env.DB as D1Database;

      // --- Chains ---
      if (path === '/api/chains' && method === 'GET') {
        let chainsResult;
        try {
            chainsResult = await db.prepare('SELECT * FROM chains ORDER BY updated_at DESC').all();
        } catch (e: any) {
            // Auto-init if table missing
            if (e.message && (e.message.includes('no such table') || e.message.includes('object not found'))) {
                await db.exec(INIT_SQL);
                chainsResult = await db.prepare('SELECT * FROM chains ORDER BY updated_at DESC').all();
            } else {
                throw e;
            }
        }
        
        const chains = chainsResult.results;

        // Fetch Versions (Assuming if chains table exists, versions exists or will be created by INIT_SQL)
        const versionsResult = await db.prepare(`
          SELECT v.* FROM versions v
          INNER JOIN (
            SELECT chain_id, MAX(version) as max_ver FROM versions GROUP BY chain_id
          ) grouped ON v.chain_id = grouped.chain_id AND v.version = grouped.max_ver
        `).all();
        
        const versionMap = new Map();
        versionsResult.results.forEach((v: any) => {
           v.modules = JSON.parse(v.modules || '[]');
           v.params = JSON.parse(v.params || '{}');
           versionMap.set(v.chain_id, v);
        });

        const data = chains.map((c: any) => ({
          ...c,
          tags: JSON.parse(c.tags || '[]'),
          latestVersion: versionMap.get(c.id) || null
        }));
        
        return json(data);
      }

      if (path === '/api/chains' && method === 'POST') {
        const { name, description } = await request.json() as any;
        const id = crypto.randomUUID();
        const now = Date.now();
        
        try {
            await db.prepare(
            'INSERT INTO chains (id, name, description, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
            ).bind(id, name, description, '[]', now, now).run();
        } catch (e: any) {
             if (e.message && (e.message.includes('no such table') || e.message.includes('object not found'))) {
                await db.exec(INIT_SQL);
                await db.prepare(
                  'INSERT INTO chains (id, name, description, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
                ).bind(id, name, description, '[]', now, now).run();
             } else throw e;
        }

        const vId = crypto.randomUUID();
        const defaultModules = JSON.stringify([{ id: crypto.randomUUID(), name: "光照", content: "cinematic lighting", isActive: true }]);
        const defaultParams = JSON.stringify({ width: 832, height: 1216, steps: 28, scale: 5, sampler: 'k_euler_ancestral' });
        
        await db.prepare(
          'INSERT INTO versions (id, chain_id, version, base_prompt, negative_prompt, modules, params, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        ).bind(vId, id, 1, 'masterpiece, best quality, {character}', 'lowres, bad anatomy', defaultModules, defaultParams, now).run();

        return json({ id });
      }

      const chainIdMatch = path.match(/^\/api\/chains\/([^\/]+)$/);
      if (chainIdMatch && method === 'PUT') {
        const id = chainIdMatch[1];
        const updates = await request.json() as any;
        const fields = [];
        const values = [];
        if (updates.name !== undefined) { fields.push('name = ?'); values.push(updates.name); }
        if (updates.description !== undefined) { fields.push('description = ?'); values.push(updates.description); }
        if (updates.previewImage !== undefined) { fields.push('preview_image = ?'); values.push(updates.previewImage); }
        
        if (fields.length > 0) {
           fields.push('updated_at = ?');
           values.push(Date.now());
           values.push(id);
           await db.prepare(`UPDATE chains SET ${fields.join(', ')} WHERE id = ?`).bind(...values).run();
        }
        return json({ success: true });
      }

      if (chainIdMatch && method === 'DELETE') {
        const id = chainIdMatch[1];
        await db.prepare('DELETE FROM chains WHERE id = ?').bind(id).run();
        return json({ success: true });
      }

      // --- Versions ---
      if (path.match(/^\/api\/chains\/[^\/]+\/versions$/) && method === 'POST') {
        const match = path.match(/^\/api\/chains\/([^\/]+)\/versions$/);
        if (!match) return error('Invalid ID');
        const chainId = match[1];
        const body = await request.json() as any;

        const maxVerResult = await db.prepare('SELECT MAX(version) as max_v FROM versions WHERE chain_id = ?').bind(chainId).first<{ max_v: number }>();
        const nextVer = ((maxVerResult?.max_v) || 0) + 1;

        const newId = crypto.randomUUID();
        await db.prepare(
          'INSERT INTO versions (id, chain_id, version, base_prompt, negative_prompt, modules, params, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        ).bind(
          newId, 
          chainId, 
          nextVer, 
          body.basePrompt || '', 
          body.negativePrompt || '', 
          JSON.stringify(body.modules || []), 
          JSON.stringify(body.params || {}), 
          Date.now()
        ).run();

        await db.prepare('UPDATE chains SET updated_at = ? WHERE id = ?').bind(Date.now(), chainId).run();

        return json({ id: newId, version: nextVer });
      }

      // --- Artists ---
      if (path === '/api/artists' && method === 'GET') {
        let results;
        try {
             const res = await db.prepare('SELECT * FROM artists ORDER BY name ASC').all();
             results = res.results;
        } catch (e: any) {
            if (e.message && (e.message.includes('no such table'))) {
                await db.exec(INIT_SQL);
                results = []; // Empty initially
            } else throw e;
        }
        return json(results);
      }
      if (path === '/api/artists' && method === 'POST') {
        const body = await request.json() as any;
        try {
            await db.prepare('INSERT OR REPLACE INTO artists (id, name, image_url) VALUES (?, ?, ?)').bind(body.id, body.name, body.imageUrl).run();
        } catch (e: any) {
            if (e.message && e.message.includes('no such table')) {
                await db.exec(INIT_SQL);
                await db.prepare('INSERT OR REPLACE INTO artists (id, name, image_url) VALUES (?, ?, ?)').bind(body.id, body.name, body.imageUrl).run();
            } else throw e;
        }
        return json({ success: true });
      }
      const artistIdMatch = path.match(/^\/api\/artists\/([^\/]+)$/);
      if (artistIdMatch && method === 'DELETE') {
        await db.prepare('DELETE FROM artists WHERE id = ?').bind(artistIdMatch[1]).run();
        return json({ success: true });
      }

      // --- Inspirations ---
      if (path === '/api/inspirations' && method === 'GET') {
        let results;
        try {
            const res = await db.prepare('SELECT * FROM inspirations ORDER BY created_at DESC').all();
            results = res.results;
        } catch (e: any) {
             if (e.message && e.message.includes('no such table')) {
                await db.exec(INIT_SQL);
                results = [];
             } else throw e;
        }
        return json(results);
      }
      if (path === '/api/inspirations' && method === 'POST') {
        const body = await request.json() as any;
        try {
             await db.prepare('INSERT OR REPLACE INTO inspirations (id, title, image_url, prompt, created_at) VALUES (?, ?, ?, ?, ?)').bind(body.id, body.title, body.imageUrl, body.prompt, body.createdAt).run();
        } catch(e: any) {
             if (e.message && e.message.includes('no such table')) {
                 await db.exec(INIT_SQL);
                 await db.prepare('INSERT OR REPLACE INTO inspirations (id, title, image_url, prompt, created_at) VALUES (?, ?, ?, ?, ?)').bind(body.id, body.title, body.imageUrl, body.prompt, body.createdAt).run();
             } else throw e;
        }
        return json({ success: true });
      }
      const inspIdMatch = path.match(/^\/api\/inspirations\/([^\/]+)$/);
      if (inspIdMatch && method === 'DELETE') {
        await db.prepare('DELETE FROM inspirations WHERE id = ?').bind(inspIdMatch[1]).run();
        return json({ success: true });
      }

      // Fallback for unknown API routes
      if (path.startsWith('/api/')) {
        return error('Not Found', 404);
      }
      
      return env.ASSETS.fetch(request);

    } catch (e: any) {
      return error(e.message, 500);
    }
  }
};
