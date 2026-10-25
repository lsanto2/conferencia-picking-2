const express=require("express"), path=require("path");
const multer=require("multer"), bcrypt=require("bcryptjs"), jwt=require("jsonwebtoken");
const {Pool}=require("pg"), XLSX=require("xlsx");

const app=express();
const PORT=Number(process.env.PORT)||10000;
const HOST="0.0.0.0";
const SECRET=process.env.JWT_SECRET||"troque-esta-chave";

if(!process.env.DATABASE_URL){
  console.error("ERRO: a variável DATABASE_URL não foi configurada.");
  process.exit(1);
}

const pool=new Pool({
  connectionString:process.env.DATABASE_URL,
  ssl:{rejectUnauthorized:false},
  max:10
});

let checkedColumnType="integer";

async function dbQuery(text,params=[]){
  return pool.query(text,params);
}

async function initDb(){
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS users(
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('ADMIN','CARGAS','CONFERENTE')),
      job_title TEXT NOT NULL DEFAULT '',
      active INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS loads(
      id BIGSERIAL PRIMARY KEY,
      transport TEXT NOT NULL,
      client TEXT NOT NULL DEFAULT 'Geral',
      plate TEXT NOT NULL DEFAULT '',
      truck_plate TEXT NOT NULL DEFAULT '',
      trailer_plate TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'PENDENTE',
      created_at TIMESTAMPTZ NOT NULL,
      started_at TIMESTAMPTZ,
      finished_at TIMESTAMPTZ,
      conferer_id BIGINT REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS items(
      id BIGSERIAL PRIMARY KEY,
      load_id BIGINT NOT NULL REFERENCES loads(id) ON DELETE CASCADE,
      sku TEXT NOT NULL,
      product TEXT NOT NULL,
      lot TEXT DEFAULT '',
      boxes DOUBLE PRECISION DEFAULT 0,
      fraction DOUBLE PRECISION DEFAULT 0,
      shortage_boxes DOUBLE PRECISION DEFAULT 0,
      shortage_units DOUBLE PRECISION DEFAULT 0,
      checked INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS audit(
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT REFERENCES users(id),
      action TEXT,
      load_id BIGINT REFERENCES loads(id),
      at TIMESTAMPTZ
    );
  `);

  await dbQuery("ALTER TABLE users ADD COLUMN IF NOT EXISTS job_title TEXT NOT NULL DEFAULT ''");
  await dbQuery("ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_photo TEXT NOT NULL DEFAULT ''");
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS monthly_report_history(
      id BIGSERIAL PRIMARY KEY,
      report_month DATE NOT NULL,
      metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
      highlight_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
      highlight_name TEXT NOT NULL DEFAULT '',
      highlight_reason TEXT NOT NULL DEFAULT '',
      criteria JSONB NOT NULL DEFAULT '{}'::jsonb,
      closed_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await dbQuery("UPDATE users SET job_title=CASE WHEN role='ADMIN' THEN 'Administrador' WHEN role='CONFERENTE' THEN 'Conferente' WHEN role='CARGAS' THEN 'Operação' ELSE job_title END WHERE COALESCE(job_title,'')=''");
  await dbQuery("ALTER TABLE loads ADD COLUMN IF NOT EXISTS plate TEXT NOT NULL DEFAULT ''");
  await dbQuery("ALTER TABLE loads ADD COLUMN IF NOT EXISTS truck_plate TEXT NOT NULL DEFAULT ''");
  await dbQuery("ALTER TABLE loads ADD COLUMN IF NOT EXISTS trailer_plate TEXT NOT NULL DEFAULT ''");
  // A placa da carreta que trouxe e a placa de alocação para conferência são a MESMA informação.
  // Primeiro preserva a alocação existente; se ela estiver vazia, recupera a antiga trailer_plate.
  await dbQuery(`
    WITH canonical AS (
      SELECT DISTINCT ON (UPPER(BTRIM(transport)))
        UPPER(BTRIM(transport)) AS transport_key,
        COALESCE(NULLIF(UPPER(BTRIM(plate)),''), NULLIF(UPPER(BTRIM(trailer_plate)),''), '') AS canonical_plate
      FROM loads
      WHERE COALESCE(BTRIM(plate),'')<>'' OR COALESCE(BTRIM(trailer_plate),'')<>''
      ORDER BY UPPER(BTRIM(transport)), (COALESCE(BTRIM(plate),'')<>'') DESC, created_at DESC, id DESC
    )
    UPDATE loads l
    SET plate=canonical.canonical_plate, trailer_plate=canonical.canonical_plate
    FROM canonical
    WHERE UPPER(BTRIM(l.transport))=canonical.transport_key
      AND (COALESCE(l.plate,'') IS DISTINCT FROM canonical.canonical_plate
        OR COALESCE(l.trailer_plate,'') IS DISTINCT FROM canonical.canonical_plate)
  `);
  await dbQuery("ALTER TABLE loads ADD COLUMN IF NOT EXISTS zvic_last4 TEXT NOT NULL DEFAULT ''");
  await dbQuery("ALTER TABLE loads ADD COLUMN IF NOT EXISTS pallet_seco DOUBLE PRECISION DEFAULT 0");
  await dbQuery("ALTER TABLE loads ADD COLUMN IF NOT EXISTS pallet_refri DOUBLE PRECISION DEFAULT 0");
  await dbQuery("ALTER TABLE loads ADD COLUMN IF NOT EXISTS pallet_total DOUBLE PRECISION DEFAULT 0");
  await dbQuery("ALTER TABLE loads ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ");
  await dbQuery("ALTER TABLE loads ADD COLUMN IF NOT EXISTS loading_status TEXT NOT NULL DEFAULT 'PENDENTE'");
  await dbQuery("ALTER TABLE loads ADD COLUMN IF NOT EXISTS loading_started_at TIMESTAMPTZ");
  await dbQuery("ALTER TABLE loads ADD COLUMN IF NOT EXISTS loading_started_by BIGINT REFERENCES users(id) ON DELETE SET NULL");
  await dbQuery("ALTER TABLE loads ADD COLUMN IF NOT EXISTS loaded_at TIMESTAMPTZ");
  await dbQuery("ALTER TABLE loads ADD COLUMN IF NOT EXISTS loaded_by BIGINT REFERENCES users(id) ON DELETE SET NULL");
  await dbQuery("ALTER TABLE loads ADD COLUMN IF NOT EXISTS loading_ready_at TIMESTAMPTZ");
  await dbQuery("CREATE INDEX IF NOT EXISTS idx_loads_loading_status ON loads(status,loading_status,finished_at)");
  // Todo picking já concluído entra automaticamente na fila de carregamento,
  // inclusive os registros antigos que ainda não tinham loading_ready_at.
  await dbQuery("UPDATE loads SET loading_ready_at=COALESCE(loading_ready_at,finished_at,NOW()), loading_status=COALESCE(loading_status,'PENDENTE') WHERE status='CONCLUIDA' AND loading_ready_at IS NULL");
  await dbQuery("ALTER TABLE items ADD COLUMN IF NOT EXISTS gross_weight DOUBLE PRECISION DEFAULT 0");
  await dbQuery("ALTER TABLE items ADD COLUMN IF NOT EXISTS checked_at TIMESTAMPTZ");
  await dbQuery("ALTER TABLE items ADD COLUMN IF NOT EXISTS checked_by BIGINT REFERENCES users(id)");
  const checkedTypeInit=await dbQuery(`SELECT data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='items' AND column_name='checked' LIMIT 1`);
  checkedColumnType=checkedTypeInit.rows[0]?.data_type||"integer";
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS load_occurrences(
      id BIGSERIAL PRIMARY KEY,
      load_id BIGINT NOT NULL REFERENCES loads(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      sku TEXT NOT NULL DEFAULT '',
      lot TEXT NOT NULL DEFAULT '',
      boxes DOUBLE PRECISION DEFAULT 0,
      units DOUBLE PRECISION DEFAULT 0,
      notes TEXT DEFAULT '',
      photo_data TEXT DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_by BIGINT REFERENCES users(id)
    );
  `);
  await dbQuery("ALTER TABLE load_occurrences ADD COLUMN IF NOT EXISTS photo_data TEXT DEFAULT ''");
  await dbQuery("ALTER TABLE load_occurrences ADD COLUMN IF NOT EXISTS client_uid TEXT");
  await dbQuery("ALTER TABLE load_occurrences ADD COLUMN IF NOT EXISTS origin_unit TEXT NOT NULL DEFAULT ''");
  await dbQuery("ALTER TABLE load_occurrences ADD COLUMN IF NOT EXISTS cause TEXT NOT NULL DEFAULT ''");
  await dbQuery("ALTER TABLE load_occurrences ADD COLUMN IF NOT EXISTS investigation_status TEXT NOT NULL DEFAULT 'EM_ANALISE'");
  await dbQuery("ALTER TABLE load_occurrences ADD COLUMN IF NOT EXISTS action_taken TEXT NOT NULL DEFAULT ''");
  await dbQuery("CREATE UNIQUE INDEX IF NOT EXISTS idx_load_occurrences_client_uid ON load_occurrences(load_id,client_uid) WHERE client_uid IS NOT NULL AND client_uid <> ''");
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS transport_checklists(
      check_date DATE NOT NULL,
      transport TEXT NOT NULL,
      printed_at TIMESTAMPTZ,
      printed_by BIGINT REFERENCES users(id),
      PRIMARY KEY(check_date,transport)
    );
  `);
  await dbQuery(`UPDATE loads l SET loading_ready_at=tc.printed_at FROM transport_checklists tc WHERE UPPER(BTRIM(l.transport))=UPPER(BTRIM(tc.transport)) AND (COALESCE(l.finished_at,l.started_at,l.created_at) AT TIME ZONE 'America/Sao_Paulo')::date=tc.check_date AND tc.printed_at IS NOT NULL AND l.loading_ready_at IS NULL`);

  const count=await dbQuery("SELECT 1 FROM users LIMIT 1");
  if(count.rowCount===0){
    const h=bcrypt.hashSync(process.env.ADMIN_PASSWORD||"admin123",10);
    await dbQuery(
      "INSERT INTO users(name,username,password_hash,role) VALUES($1,$2,$3,$4)",
      ["Administrador","admin",h,"ADMIN"]
    );
  }
}

app.disable("x-powered-by");
app.use(express.json({limit:"6mb"}));
app.use(express.urlencoded({extended:true}));
app.use(express.static(path.join(__dirname,"public")));

// APIs nunca devem ser armazenadas por navegador, proxy ou cache intermediário.
// Os dados de conferência precisam refletir sempre o estado atual do banco.
app.use((req,res,next)=>{
  if(req.path.startsWith("/api/")){
    res.set("Cache-Control","no-store, no-cache, must-revalidate, proxy-revalidate");
    res.set("Pragma","no-cache");
    res.set("Expires","0");
  }
  next();
});

app.get("/api/health",(req,res)=>res.status(200).json({
  ok:true,service:"conferencia-picking",time:new Date().toISOString()
}));

const upload=multer({
  storage:multer.memoryStorage(),
  limits:{fileSize:10*1024*1024}
});

function auth(req,res,next){
  try{
    const h=req.headers.authorization||"";
    req.user=jwt.verify(h.replace("Bearer ",""),SECRET);
    next();
  }catch(e){
    res.status(401).json({error:"Não autorizado"});
  }
}

function roles(...r){
  return (req,res,next)=>r.includes(req.user.role)
    ? next()
    : res.status(403).json({error:"Sem permissão"});
}

async function audit(user,action,load){
  await dbQuery(
    "INSERT INTO audit(user_id,action,load_id,at) VALUES($1,$2,$3,NOW())",
    [user,action,load||null]
  );
}

app.post(["/api/login","/api/login/"],async(req,res)=>{
  try{
    const r=await dbQuery(
      "SELECT * FROM users WHERE username=$1 AND active=1",
      [req.body.username]
    );
    const u=r.rows[0];
    if(!u||!bcrypt.compareSync(req.body.password||"",u.password_hash))
      return res.status(401).json({error:"Usuário ou senha inválidos"});

    const token=jwt.sign(
      {id:Number(u.id),name:u.name,role:u.role,job_title:u.job_title||""},
      SECRET,
      {expiresIn:"12h"}
    );
    res.json({
      token,
      user:{id:Number(u.id),name:u.name,role:u.role,job_title:u.job_title||""}
    });
  }catch(e){
    console.error(e);
    res.status(500).json({error:"Erro interno do servidor"});
  }
});

app.get("/api/me",auth,async(req,res)=>{
  try{
    const r=await dbQuery("SELECT id,name,username,role,job_title,profile_photo FROM users WHERE id=$1 AND active=1",[req.user.id]);
    if(!r.rowCount)return res.status(401).json({error:"Usuário não encontrado ou inativo"});
    const u=r.rows[0];res.json({id:Number(u.id),name:u.name,username:u.username,role:u.role,job_title:u.job_title||"",profile_photo:u.profile_photo||""});
  }catch(e){console.error(e);res.status(500).json({error:"Não foi possível carregar o perfil"});}
});
app.get("/api/me/profile",auth,async(req,res)=>{
  try{const r=await dbQuery("SELECT id,name,job_title,role,profile_photo FROM users WHERE id=$1 AND active=1",[req.user.id]);if(!r.rowCount)return res.status(404).json({error:"Perfil não encontrado"});const u=r.rows[0];res.json({id:Number(u.id),name:u.name,job_title:u.job_title||"",role:u.role,profile_photo:u.profile_photo||""});}
  catch(e){console.error(e);res.status(500).json({error:"Não foi possível carregar a foto do perfil"});}
});
app.put("/api/me/profile-photo",auth,async(req,res)=>{
  try{
    const photo=String(req.body?.photo||"");
    if(photo && (!/^data:image\/(jpeg|png|webp);base64,/i.test(photo) || photo.length>1500000))return res.status(400).json({error:"Imagem inválida ou muito grande. Escolha uma foto menor."});
    const r=await dbQuery("UPDATE users SET profile_photo=$1 WHERE id=$2 AND active=1 RETURNING id",[photo,req.user.id]);
    if(!r.rowCount)return res.status(404).json({error:"Perfil não encontrado"});
    await dbQuery("INSERT INTO audit(user_id,action,load_id,at) VALUES($1,$2,NULL,NOW())",[req.user.id,photo?"ATUALIZOU_FOTO_PERFIL":"REMOVEU_FOTO_PERFIL"]);
    res.json({ok:true,profile_photo:photo});
  }catch(e){console.error(e);res.status(500).json({error:"Não foi possível salvar a foto. Tente uma imagem menor."});}
});

app.get("/api/users/:id/profile-photo",auth,roles("ADMIN","CARGAS"),async(req,res)=>{
  try{const r=await dbQuery("SELECT profile_photo FROM users WHERE id=$1 AND active=1",[req.params.id]);if(!r.rowCount)return res.status(404).json({error:"Usuário não encontrado"});res.json({profile_photo:r.rows[0].profile_photo||""});}
  catch(e){console.error(e);res.status(500).json({error:"Não foi possível carregar a foto"});}
});

app.get("/api/users",auth,roles("ADMIN"),async(req,res)=>{
  try{
    const r=await dbQuery(
      "SELECT id,name,username,role,job_title,active FROM users ORDER BY name"
    );
    res.json(r.rows);
  }catch(e){
    console.error(e);
    res.status(500).json({error:"Erro interno do servidor"});
  }
});

app.post("/api/users",auth,roles("ADMIN"),async(req,res)=>{
  const {name,username,password,role}=req.body;
  const jobTitle=String(req.body?.job_title||"").trim();
  if(!name||!username||!password||!["ADMIN","CARGAS","CONFERENTE"].includes(role))
    return res.status(400).json({error:"Preencha todos os campos"});

  try{
    const r=await dbQuery(
      "INSERT INTO users(name,username,password_hash,role) VALUES($1,$2,$3,$4) RETURNING id",
      [name,username,bcrypt.hashSync(password,10),role]
    );
    res.json({id:Number(r.rows[0].id)});
  }catch(e){
    res.status(400).json({error:"Usuário já existe"});
  }
});

app.delete("/api/users/:id",auth,roles("ADMIN"),async(req,res)=>{
  try{
    const id=Number(req.params.id);
    if(id===Number(req.user.id))
      return res.status(400).json({error:"Você não pode excluir o próprio usuário"});

    const r=await dbQuery("SELECT id,name FROM users WHERE id=$1",[id]);
    if(!r.rowCount)
      return res.status(404).json({error:"Usuário não encontrado"});

    // Remove vínculos de auditoria para permitir a exclusão.
    // Cargas concluídas/em andamento mantêm o histórico, mas deixam de apontar
    // para o usuário excluído.
    await dbQuery("UPDATE loads SET conferer_id=NULL WHERE conferer_id=$1",[id]);
    await dbQuery("UPDATE audit SET user_id=NULL WHERE user_id=$1",[id]);
    await dbQuery("DELETE FROM users WHERE id=$1",[id]);

    res.json({ok:true});
  }catch(e){
    console.error(e);
    res.status(500).json({error:"Não foi possível excluir o usuário"});
  }
});

app.patch("/api/users/:id",auth,roles("ADMIN"),async(req,res)=>{
  try{
    const currentR=await dbQuery("SELECT id,role,job_title,active FROM users WHERE id=$1",[req.params.id]);
    const current=currentR.rows[0];
    if(!current)return res.status(404).json({error:"Usuário não encontrado"});
    const hasActive=Object.prototype.hasOwnProperty.call(req.body||{},"active");
    const hasJob=Object.prototype.hasOwnProperty.call(req.body||{},"job_title");
    const active=hasActive?(req.body.active?1:0):current.active;
    const defaultTitle=current.role==="ADMIN"?"Administrador":current.role==="CARGAS"?"Operação":"Conferente";
    const jobTitle=hasJob?(String(req.body.job_title||"").trim()||defaultTitle):(current.job_title||defaultTitle);
    await dbQuery("UPDATE users SET active=$1,job_title=$2 WHERE id=$3",[active,jobTitle,req.params.id]);
    res.json({ok:true,job_title:jobTitle,active:!!active});
  }catch(e){
    console.error(e);
    res.status(500).json({error:"Erro interno do servidor"});
  }
});

// Compara as linhas do SAP sem depender da ordem do arquivo, maiúsculas/minúsculas
// ou espaços extras. A confirmação continua disponível para duplicidades legítimas.
function duplicateTextKey(value){
  return String(value??"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").trim().replace(/\s+/g," ").toLocaleLowerCase("pt-BR");
}
function duplicateNumberKey(value){
  const n=Number(value??0);
  return Number.isFinite(n)?Math.round(n*1000000)/1000000:0;
}
function itemsDuplicateFingerprint(rows){
  const normalized=rows.map(r=>[
    duplicateTextKey(r.sku),
    duplicateTextKey(r.product),
    duplicateTextKey(r.lot),
    duplicateNumberKey(r.boxes),
    duplicateNumberKey(r.fraction)
  ]);
  normalized.sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return JSON.stringify(normalized);
}
async function findDuplicateLoad(db,transport,rows,totalWeight){
  const incomingFingerprint=itemsDuplicateFingerprint(rows);
  const existing=await db.query(`
    SELECT l.id,l.transport,l.client,l.created_at,l.status,
      COALESCE(w.item_count,0)::int AS item_count,
      COALESCE(w.total_weight,0)::float8 AS total_weight,
      COALESCE(NULLIF(importer.name,''),NULLIF(conf.name,''),'usuário não identificado') AS responsible_name
    FROM loads l
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS item_count,COALESCE(SUM(i.gross_weight),0)::float8 AS total_weight
      FROM items i WHERE i.load_id=l.id
    ) w ON TRUE
    LEFT JOIN users conf ON conf.id=l.conferer_id
    LEFT JOIN LATERAL (
      SELECT u.name
      FROM audit a JOIN users u ON u.id=a.user_id
      WHERE a.load_id=l.id AND a.action='IMPORTOU_CARGA'
      ORDER BY a.at ASC,a.id ASC LIMIT 1
    ) importer ON TRUE
    WHERE UPPER(BTRIM(l.transport))=UPPER(BTRIM($1))
    ORDER BY l.created_at DESC,l.id DESC
  `,[transport]);
  const candidates=existing.rows.filter(x=>
    Number(x.item_count)===rows.length &&
    Math.round(Number(x.total_weight||0)*100)===Math.round(Number(totalWeight||0)*100)
  );
  if(!candidates.length)return null;
  const ids=candidates.map(x=>Number(x.id));
  const ir=await db.query(`
    SELECT load_id,sku,product,lot,boxes,fraction
    FROM items WHERE load_id=ANY($1::bigint[]) ORDER BY load_id,id
  `,[ids]);
  const grouped=new Map();
  for(const row of ir.rows){
    const id=Number(row.load_id);
    if(!grouped.has(id))grouped.set(id,[]);
    grouped.get(id).push(row);
  }
  for(const candidate of candidates){
    const previousItems=grouped.get(Number(candidate.id))||[];
    if(itemsDuplicateFingerprint(previousItems)!==incomingFingerprint)continue;
    return {
      id:Number(candidate.id),transport:String(candidate.transport||transport),client:String(candidate.client||""),
      created_at:candidate.created_at,status:String(candidate.status||""),
      total_weight:Number(candidate.total_weight||0),item_count:Number(candidate.item_count||0),
      responsible_name:String(candidate.responsible_name||"usuário não identificado")
    };
  }
  return null;
}

app.post("/api/loads/import",auth,roles("ADMIN","CARGAS"),upload.single("file"),async(req,res)=>{
  if(!req.file)return res.status(400).json({error:"Arquivo não enviado"});

  const transport=(req.body.transport||"").trim();
  const client=(req.body.client||"Geral").trim()||"Geral";
  const truckPlate=String(req.body.truck_plate||"").trim().toUpperCase();
  const trailerPlate=String(req.body.trailer_plate||"").trim().toUpperCase();
  const zvicLast4=String(req.body.zvic_last4||"").replace(/\D/g,"").slice(-4);
  if(!transport)return res.status(400).json({error:"Informe o transporte"});

  let rows=[];
  const ext=path.extname(req.file.originalname).toLowerCase();

  try{
    if(ext===".xlsx"||ext===".xls"){
      const wb=XLSX.read(req.file.buffer,{type:"buffer"});
      const ws=wb.Sheets[wb.SheetNames[0]];
      const data=XLSX.utils.sheet_to_json(ws,{header:1,defval:""});
      const head=data.findIndex(r=>r.some(v=>
        String(v).toLowerCase().includes("cód.item")||
        String(v).toLowerCase().includes("cod.item")
      ));
      if(head<0)throw Error("Cabeçalho SAP não encontrado");

      const h=data[head].map(v=>String(v).toLowerCase()
        .normalize("NFD").replace(/[\u0300-\u036f]/g,"").trim());

      const ix={
        sku:h.findIndex(x=>x.includes("cod.item")),
        prod:h.findIndex(x=>x.includes("descricao do produto")),
        lot:h.findIndex(x=>x==="lote"||x.includes("lote")),
        box:h.findIndex(x=>x.includes("unid.exp.(caixa)")),
        frac:h.findIndex(x=>x.includes("unid.exp.(fracao)")),
        grossWeight:h.findIndex(x=>x.includes("peso bruto")||x.includes("peso.bruto")||x.includes("peso bruto total")||x.includes("peso total bruto"))
      };

      if(ix.sku<0||ix.prod<0||ix.box<0||ix.frac<0)
        throw Error("O arquivo precisa conter SKU, produto, caixas e fração");

      const n=v=>{
        let s=String(v??"").trim().replace(/\s/g,"");
        if(!s)return 0;
        if(s.includes(",") && s.includes(".")) s=s.replace(/\./g,"").replace(",",".");
        else if(s.includes(",")) s=s.replace(",",".");
        const x=parseFloat(s);
        return Number.isFinite(x)?x:0;
      };

      rows=data.slice(head+1)
        .map(r=>({
          sku:String(r[ix.sku]||"").trim(),
          product:String(r[ix.prod]||"").trim(),
          lot:ix.lot>=0?String(r[ix.lot]||"").trim():"",
          boxes:n(r[ix.box]),
          fraction:n(r[ix.frac]),
          gross_weight:ix.grossWeight>=0?n(r[ix.grossWeight]):0
        }))
        .filter(r=>r.sku);

    }else if(ext===".html"||ext===".htm"){
      const s=req.file.buffer.toString("utf8");
      const trs=[...s.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)]
        .map(m=>[...m[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)]
        .map(x=>x[1].replace(/<[^>]+>/g," ")
          .replace(/&nbsp;/g," ")
          .replace(/&amp;/g,"&")
          .trim()));

      const head=trs.findIndex(r=>r.some(v=>
        v.toLowerCase().includes("cód.item")||
        v.toLowerCase().includes("cod.item")
      ));
      if(head<0)throw Error("Cabeçalho SAP não encontrado");

      const h=trs[head].map(v=>v.toLowerCase()
        .normalize("NFD").replace(/[\u0300-\u036f]/g,"").trim());

      const ix={
        sku:h.findIndex(x=>x.includes("cod.item")),
        prod:h.findIndex(x=>x.includes("descricao do produto")),
        lot:h.findIndex(x=>x==="lote"||x.includes("lote")),
        box:h.findIndex(x=>x.includes("unid.exp.(caixa)")),
        frac:h.findIndex(x=>x.includes("unid.exp.(fracao)")),
        grossWeight:h.findIndex(x=>x.includes("peso bruto")||x.includes("peso.bruto")||x.includes("peso bruto total")||x.includes("peso total bruto"))
      };

      if(ix.sku<0||ix.prod<0||ix.box<0||ix.frac<0)
        throw Error("O HTML precisa conter SKU, produto, caixas e fração");

      const n=v=>{
        let ss=String(v??"").trim().replace(/\s/g,"");
        if(!ss)return 0;
        if(ss.includes(",") && ss.includes(".")) ss=ss.replace(/\./g,"").replace(",",".");
        else if(ss.includes(",")) ss=ss.replace(",",".");
        const x=parseFloat(ss);
        return Number.isFinite(x)?x:0;
      };

      rows=trs.slice(head+1)
        .map(r=>({
          sku:r[ix.sku]||"",
          product:r[ix.prod]||"",
          lot:ix.lot>=0?r[ix.lot]||"":"",
          boxes:n(r[ix.box]),
          fraction:n(r[ix.frac]),
          gross_weight:ix.grossWeight>=0?n(r[ix.grossWeight]):0
        }))
        .filter(r=>r.sku);

    }else{
      throw Error("Use HTML ou XLSX do SAP");
    }

    if(!rows.length)throw Error("Nenhum item encontrado");

    const clientDb=await pool.connect();
    try{
      await clientDb.query("BEGIN");
      // Serializa integrações do mesmo transporte para que dois usuários não consigam
      // importar simultaneamente a mesma carga sem receber o alerta.
      await clientDb.query("SELECT pg_advisory_xact_lock(hashtext($1)::bigint)",["sap-import:"+transport.trim().toUpperCase()]);
      const totalGrossWeight=rows.reduce((sum,r)=>sum+Number(r.gross_weight||0),0);
      const duplicateLoad=await findDuplicateLoad(clientDb,transport,rows,totalGrossWeight);
      const allowDuplicate=String(req.body?.allow_duplicate||"").toLowerCase()==="true";
      if(duplicateLoad&&!allowDuplicate){
        await clientDb.query("ROLLBACK");
        return res.status(409).json({
          duplicate:true,
          error:"Possível duplicidade: já existe uma carga deste transporte com o mesmo peso bruto e a mesma lista de produtos/SKUs.",
          duplicateLoad
        });
      }

      // Se o usuário informar a carreta na importação, essa placa também é a alocação para conferência.
      // Se não informar, herda a placa já registrada para outros pickings do mesmo transporte, se houver.
      let canonicalTrailerPlate=trailerPlate;
      if(!canonicalTrailerPlate){
        const existingPlate=await clientDb.query(`
          SELECT COALESCE(NULLIF(UPPER(BTRIM(plate)),''),NULLIF(UPPER(BTRIM(trailer_plate)),''),'') AS plate
          FROM loads
          WHERE UPPER(BTRIM(transport))=UPPER(BTRIM($1))
            AND (COALESCE(BTRIM(plate),'')<>'' OR COALESCE(BTRIM(trailer_plate),'')<>'')
          ORDER BY (COALESCE(BTRIM(plate),'')<>'') DESC, created_at DESC, id DESC
          LIMIT 1
        `,[transport]);
        canonicalTrailerPlate=String(existingPlate.rows[0]?.plate||'');
      }
      const l=await clientDb.query(
        "INSERT INTO loads(transport,client,plate,truck_plate,trailer_plate,zvic_last4,created_at) VALUES($1,$2,$3,$4,$3,$5,NOW()) RETURNING id",
        [transport,client,canonicalTrailerPlate,truckPlate,zvicLast4]
      );
      const loadId=Number(l.rows[0].id);
      // Um transporte pode aparecer em vários pickings/clientes: manter a placa da carreta única em todos.
      if(canonicalTrailerPlate){
        await clientDb.query(`
          UPDATE loads SET plate=$1,trailer_plate=$1
          WHERE UPPER(BTRIM(transport))=UPPER(BTRIM($2::text))
        `,[canonicalTrailerPlate,transport]);
      }

      // Inserção em lotes: reduz centenas de round-trips ao banco para poucos comandos.
      const batchSize=300;
      for(let offset=0;offset<rows.length;offset+=batchSize){
        const batch=rows.slice(offset,offset+batchSize);
        const values=[]; const placeholders=[];
        for(const r of batch){
          const base=values.length;
          values.push(loadId,r.sku,r.product,r.lot,r.boxes,r.fraction,r.gross_weight||0);
          placeholders.push(`($${base+1},$${base+2},$${base+3},$${base+4},$${base+5},$${base+6},$${base+7})`);
        }
        await clientDb.query(`INSERT INTO items(load_id,sku,product,lot,boxes,fraction,gross_weight) VALUES ${placeholders.join(',')}`,values);
      }

      await clientDb.query(
        "INSERT INTO audit(user_id,action,load_id,at) VALUES($1,$2,$3,NOW())",
        [req.user.id,"IMPORTOU_CARGA",loadId]
      );
      if(duplicateLoad&&allowDuplicate){
        await clientDb.query(
          "INSERT INTO audit(user_id,action,load_id,at) VALUES($1,$2,$3,NOW())",
          [req.user.id,"CONFIRMOU_IMPORTACAO_DUPLICADA",loadId]
        );
      }

      await clientDb.query("COMMIT");
      res.json({id:loadId,count:rows.length,duplicate_confirmed:Boolean(duplicateLoad&&allowDuplicate)});
    }catch(e){
      await clientDb.query("ROLLBACK");
      throw e;
    }finally{
      clientDb.release();
    }

  }catch(e){
    console.error(e);
    res.status(400).json({error:e.message});
  }
});

// Busca geral de produtos em todos os pickings de uma data de operação.
app.get("/api/global-product-search",auth,async(req,res)=>{
  try{
    const date=String(req.query.date||"").trim();
    const q=String(req.query.q||"").trim();
    if(!/^\d{4}-\d{2}-\d{2}$/.test(date))return res.status(400).json({error:"Selecione uma data válida."});
    if(!q)return res.json([]);
    const like=`%${q.replace(/[\\%_]/g,"\\$&")}%`;
    const r=await dbQuery(`
      SELECT i.id AS item_id,i.sku,i.product,i.lot,i.boxes,i.fraction,i.shortage_boxes,i.shortage_units,
        l.id AS load_id,l.transport,l.client,l.status AS load_status,l.created_at,l.started_at,l.finished_at,
        l.plate,l.truck_plate,u.name AS conferer_name,
        (COALESCE(l.finished_at,l.started_at,l.created_at) AT TIME ZONE 'America/Sao_Paulo')::date::text AS operation_date
      FROM items i JOIN loads l ON l.id=i.load_id
      LEFT JOIN users u ON u.id=l.conferer_id
      WHERE (COALESCE(l.finished_at,l.started_at,l.created_at) AT TIME ZONE 'America/Sao_Paulo')::date=$1::date
        AND (i.sku ILIKE $2 ESCAPE '\\' OR i.product ILIKE $2 ESCAPE '\\' OR COALESCE(i.lot,'') ILIKE $2 ESCAPE '\\')
      ORDER BY l.transport,l.client,i.product,i.sku
      LIMIT 500
    `,[date,like]);
    res.json(r.rows);
  }catch(e){console.error("global product search",e);res.status(500).json({error:"Não foi possível pesquisar os produtos."});}
});

// Quadro de carregamento agrupado por transporte + data da operação.
// Um transporte só fica disponível quando TODOS os clientes/pickings do grupo estiverem concluídos.
app.get("/api/loading-board",auth,async(req,res)=>{
  try{
    const status=String(req.query.status||"active").toLowerCase();
    const date=String(req.query.date||"").trim();
    const q=String(req.query.q||"").trim();
    const where=[];
    const params=[];let p=1;
    if(date && /^\d{4}-\d{2}-\d{2}$/.test(date)){
      where.push("(COALESCE(l.finished_at,l.started_at,l.created_at) AT TIME ZONE 'America/Sao_Paulo')::date=$"+(p++)+"::date");
      params.push(date);
    }
    const r=await dbQuery(`
      SELECT l.id,l.transport,l.client,l.plate,l.truck_plate,l.status,l.created_at,l.started_at,l.finished_at,
        COALESCE(l.pallet_seco,0)::float8 AS pallet_seco,COALESCE(l.pallet_refri,0)::float8 AS pallet_refri,COALESCE(l.pallet_total,COALESCE(l.pallet_seco,0)+COALESCE(l.pallet_refri,0))::float8 AS pallet_total,
        COALESCE(l.loading_status,'PENDENTE') AS loading_status,l.loading_ready_at,l.loading_started_at,l.loaded_at,
        starter.name AS loading_started_by_name,loader.name AS loaded_by_name,u.name AS conferer_name,
        (COALESCE(l.finished_at,l.started_at,l.created_at) AT TIME ZONE 'America/Sao_Paulo')::date::text AS operation_date,
        COUNT(i.id)::int AS item_count,COALESCE(SUM(i.boxes),0)::float8 AS total_boxes
      FROM loads l
      LEFT JOIN users u ON u.id=l.conferer_id
      LEFT JOIN users starter ON starter.id=l.loading_started_by
      LEFT JOIN users loader ON loader.id=l.loaded_by
      LEFT JOIN items i ON i.load_id=l.id
      ${where.length ? "WHERE "+where.join(" AND ") : ""}
      GROUP BY l.id,u.name,starter.name,loader.name
      ORDER BY l.transport,(COALESCE(l.finished_at,l.started_at,l.created_at) AT TIME ZONE 'America/Sao_Paulo')::date,l.client,l.id
    `,params);
    const groups=new Map();
    for(const row of r.rows){
      const transport=String(row.transport||"").trim();
      const day=String(row.operation_date||"");
      const key=transport.toLocaleUpperCase("pt-BR")+"|"+day;
      if(!groups.has(key))groups.set(key,{id:Number(row.id),transport,operation_date:day,plate:row.plate||"",truck_plate:row.truck_plate||"",loads:[],clients:[],conferers:[],item_count:0,total_boxes:0,pallet_seco:0,pallet_refri:0,pallet_total:0,all_concluded:true,all_loaded:true,any_loading:false,loaded_at:null,loaded_by_name:null,loading_started_at:null,loading_started_by_name:null,loading_ready_at:null});
      const g=groups.get(key);g.loads.push(row);
      const clientName=String(row.client||"Geral");if(!g.clients.includes(clientName))g.clients.push(clientName);
      if(row.conferer_name&&!g.conferers.includes(row.conferer_name))g.conferers.push(row.conferer_name);
      g.item_count+=Number(row.item_count||0);g.total_boxes+=Number(row.total_boxes||0);g.pallet_seco+=Number(row.pallet_seco||0);g.pallet_refri+=Number(row.pallet_refri||0);g.pallet_total+=Number(row.pallet_total||0);
      if(String(row.status||"").toUpperCase()!=="CONCLUIDA")g.all_concluded=false;
      const ls=String(row.loading_status||"PENDENTE").toUpperCase();if(ls!=="CARREGADO")g.all_loaded=false;if(ls==="CARREGANDO")g.any_loading=true;
      if(row.loaded_at&&(!g.loaded_at||new Date(row.loaded_at)>new Date(g.loaded_at))){g.loaded_at=row.loaded_at;g.loaded_by_name=row.loaded_by_name;}
      if(row.loading_started_at&&(!g.loading_started_at||new Date(row.loading_started_at)>new Date(g.loading_started_at))){g.loading_started_at=row.loading_started_at;g.loading_started_by_name=row.loading_started_by_name;}
      if(row.loading_ready_at)g.loading_ready_at=row.loading_ready_at;if(row.plate)g.plate=row.plate;if(row.truck_plate)g.truck_plate=row.truck_plate;
    }
    let out=[...groups.values()].map(g=>{
      g.clients.sort((a,b)=>a.localeCompare(b,"pt-BR"));g.conferers.sort((a,b)=>a.localeCompare(b,"pt-BR"));
      g.client_count=g.clients.length;g.load_count=g.loads.length;g.conference_ready=g.all_concluded;
      g.loading_status=g.all_loaded?"CARREGADO":g.any_loading?"CARREGANDO":"PENDENTE";
      g.conferer_name=g.conferers.join(", ")||"—";
      delete g.all_concluded;delete g.all_loaded;delete g.any_loading;delete g.loads;
      return g;
    });
    if(q){const needle=q.toLocaleLowerCase("pt-BR");out=out.filter(g=>(g.transport+" "+g.clients.join(" ")+" "+g.conferers.join(" ")).toLocaleLowerCase("pt-BR").includes(needle));}
    if(status==="active")out=out.filter(g=>g.loading_status!=="CARREGADO");else if(status==="loaded")out=out.filter(g=>g.loading_status==="CARREGADO");
    res.json(out);
  }catch(e){console.error("loading board",e);res.status(500).json({error:"Não foi possível carregar a aba de carregamentos."});}
});

app.patch("/api/loading-board/:id",auth,roles("ADMIN","CARGAS","CONFERENTE"),async(req,res)=>{
  const client=await pool.connect();
  try{
    const id=Number(req.params.id),next=String(req.body?.status||"").toUpperCase();
    if(!Number.isSafeInteger(id)||id<=0)return res.status(400).json({error:"Transporte inválido."});
    if(!["CARREGADO","PENDENTE"].includes(next))return res.status(400).json({error:"Status de carregamento inválido."});
    await client.query("BEGIN");
    const found=await client.query("SELECT transport,(COALESCE(finished_at,started_at,created_at) AT TIME ZONE 'America/Sao_Paulo')::date AS operation_day FROM loads WHERE id=$1 FOR UPDATE",[id]);
    if(!found.rowCount){await client.query("ROLLBACK");return res.status(404).json({error:"Transporte não encontrado."});}
    const {transport,operation_day}=found.rows[0];
    const related=await client.query("SELECT id,status FROM loads WHERE UPPER(BTRIM(transport))=UPPER(BTRIM($1::text)) AND (COALESCE(finished_at,started_at,created_at) AT TIME ZONE 'America/Sao_Paulo')::date=$2::date FOR UPDATE",[transport,operation_day]);
    if(next==="CARREGADO"&&related.rows.some(x=>String(x.status||"").toUpperCase()!=="CONCLUIDA")){await client.query("ROLLBACK");return res.status(409).json({error:"Indisponível para carregamento: finalize a conferência de todos os clientes deste transporte primeiro."});}
    const ids=related.rows.map(x=>Number(x.id));
    await client.query("UPDATE loads SET loading_status=$1,loading_started_at=CASE WHEN $1='CARREGADO' THEN COALESCE(loading_started_at,NOW()) ELSE NULL END,loading_started_by=CASE WHEN $1='CARREGADO' THEN COALESCE(loading_started_by,$2) ELSE NULL END,loaded_at=CASE WHEN $1='CARREGADO' THEN NOW() ELSE NULL END,loaded_by=CASE WHEN $1='CARREGADO' THEN $2 ELSE NULL END WHERE id=ANY($3::bigint[])",[next,req.user.id,ids]);
    await client.query("INSERT INTO audit(user_id,action,load_id,at) SELECT $1,$2,x,NOW() FROM unnest($3::bigint[]) AS x",[req.user.id,next==="CARREGADO"?"MARCOU_TRANSPORTE_CARREGADO":"CORRIGIU_CARREGAMENTO_PARA_PENDENTE",ids]);
    await client.query("COMMIT");res.json({ok:true,status:next,updated:ids.length});
  }catch(e){await client.query("ROLLBACK").catch(()=>{});console.error("update loading status",e);res.status(500).json({error:"Não foi possível atualizar o status de carregamento."});}
  finally{client.release();}
});

app.get("/api/loads",auth,async(req,res)=>{
  try{
    const q=(req.query.q||"").toLowerCase();
    const date=(req.query.date||"").trim();
    const status=(req.query.status||"").trim();
    const mine=req.query.mine==="1";
    const where=[]; const params=[]; let p=1;
    if(date){where.push(`(l.created_at AT TIME ZONE 'America/Sao_Paulo')::date=$${p++}::date`);params.push(date);}
    if(status){where.push(`l.status=$${p++}`);params.push(status);}
    if(mine && req.user.role==="CONFERENTE"){where.push(`l.conferer_id=$${p++}`);params.push(req.user.id);}
    const whereSql=where.length?"WHERE "+where.join(" AND "):"";
    const loads=await dbQuery(`
      SELECT l.*,u.name AS conferer_name,
        COALESCE(i.items_json,'[]'::json) AS items,
        COALESCE(o.occurrence_count,0)::int AS occurrence_count,
        COALESCE(o.occ_sobra,0)::int AS occ_sobra,
        COALESCE(o.occ_avaria,0)::int AS occ_avaria,
        COALESCE(o.occ_inversao,0)::int AS occ_inversao,
        COALESCE(o.occ_vencido,0)::int AS occ_vencido,
        COALESCE(o.occ_outro,0)::int AS occ_outro,
        COALESCE(o.occ_photos,0)::int AS occ_photos
      FROM loads l
      LEFT JOIN users u ON u.id=l.conferer_id
      LEFT JOIN LATERAL (
        SELECT json_agg(i ORDER BY i.id) AS items_json FROM items i WHERE i.load_id=l.id
      ) i ON true
      LEFT JOIN LATERAL (
        SELECT COUNT(*) AS occurrence_count,
          COUNT(*) FILTER (WHERE UPPER(type)='SOBRA') AS occ_sobra,
          COUNT(*) FILTER (WHERE UPPER(type)='AVARIA') AS occ_avaria,
          COUNT(*) FILTER (WHERE UPPER(type)='INVERSAO') AS occ_inversao,
          COUNT(*) FILTER (WHERE UPPER(type)='VENCIDO') AS occ_vencido,
          COUNT(*) FILTER (WHERE UPPER(type)='OUTRO') AS occ_outro,
          COUNT(*) FILTER (WHERE COALESCE(photo_data,'') <> '') AS occ_photos
        FROM load_occurrences WHERE load_id=l.id
      ) o ON true
      ${whereSql}
      ORDER BY CASE l.status WHEN 'PENDENTE' THEN 1 WHEN 'EM_CONFERENCIA' THEN 2 ELSE 3 END,l.id DESC
    `,params);
    const out=loads.rows.filter(l=>(String(l.transport)+" "+String(l.client)+" "+String(l.conferer_name||"")).toLowerCase().includes(q) || String(l.zvic_last4||"").toLowerCase().includes(q))
      .map(l=>{
        const items=Array.isArray(l.items)?l.items:[];
        const total=items.length;
        const checked=items.filter(i=>Number(i.checked)).length;
        const lastSeenMs=l.last_seen_at?new Date(l.last_seen_at).getTime():NaN;
        const confererOnline=String(l.status||"").toUpperCase()==="EM_CONFERENCIA" && Number.isFinite(lastSeenMs) && (Date.now()-lastSeenMs)<=45000;
        return {...l,id:Number(l.id),items,progress_total:total,progress_checked:checked,progress_pct:total?Math.round(checked/total*100):0,conferer_online:confererOnline,conferer_last_seen:l.last_seen_at||null};
      });
    res.json(out);
  }catch(e){console.error(e);res.status(500).json({error:"Erro interno do servidor"});}
});

app.patch("/api/loads/:id/vehicle-plates",auth,roles("ADMIN","CARGAS"),async(req,res)=>{
  const loadId=Number(req.params.id);
  if(!Number.isSafeInteger(loadId)||loadId<=0)return res.status(400).json({error:"Identificador de transporte inválido."});
  const hasTruck=Object.prototype.hasOwnProperty.call(req.body||{},"truck_plate");
  const hasTrailer=Object.prototype.hasOwnProperty.call(req.body||{},"trailer_plate");
  if(!hasTruck&&!hasTrailer)return res.status(400).json({error:"Escolha a placa do truck/cavalo ou da carreta que trouxe."});
  const truckPlate=hasTruck?String(req.body.truck_plate||"").trim().toUpperCase():null;
  const trailerPlate=hasTrailer?String(req.body.trailer_plate||"").trim().toUpperCase():null;
  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    const target=await client.query("SELECT id,transport FROM loads WHERE id=$1 FOR SHARE",[loadId]);
    if(!target.rowCount){await client.query("ROLLBACK");return res.status(404).json({error:"Transporte não encontrado."});}
    const transport=String(target.rows[0].transport||"").trim();
    const r=await client.query(`
      UPDATE loads
      SET truck_plate=CASE WHEN $1::boolean THEN $2::text ELSE truck_plate END,
          plate=CASE WHEN $3::boolean THEN $4::text ELSE plate END,
          trailer_plate=CASE WHEN $3::boolean THEN $4::text ELSE COALESCE(NULLIF(BTRIM(plate),''),trailer_plate) END
      WHERE UPPER(BTRIM(transport))=UPPER(BTRIM($5::text))
      RETURNING id,transport,plate,truck_plate,trailer_plate,status,finished_at
    `,[hasTruck,truckPlate,hasTrailer,trailerPlate,transport]);
    const auditIds=r.rows.map(row=>Number(row.id));
    if(auditIds.length){
      await client.query(`
        INSERT INTO audit(user_id,action,load_id,at)
        SELECT $1,$2,entry.id,NOW()
        FROM unnest($3::bigint[]) AS entry(id)
      `,[req.user.id,`ATUALIZOU_${hasTruck?"PLACA_TRUCK_CAVALO":"PLACA_CARRETA_E_ALOCACAO"}`,auditIds]);
    }
    await client.query("COMMIT");
    const updatedLoad=r.rows.find(row=>Number(row.id)===loadId)||r.rows[0];
    res.json({ok:true,load:updatedLoad,updated:r.rowCount,transport,message:`Placa atualizada para todos os pickings do transporte ${transport}.`});
  }catch(e){
    try{await client.query("ROLLBACK");}catch(_){}
    console.error(e);
    res.status(500).json({error:"Não foi possível atualizar as placas do veículo."});
  }finally{
    client.release();
  }
});

app.post("/api/loads/allocate",auth,roles("ADMIN","CARGAS"),async(req,res)=>{
  const ids=[...new Set((Array.isArray(req.body?.ids)?req.body.ids:[]).map(Number).filter(n=>Number.isSafeInteger(n)&&n>0))];
  const plate=String(req.body?.plate||"").trim().toUpperCase();
  if(!ids.length)return res.status(400).json({error:"Selecione pelo menos um transporte."});
  if(!plate)return res.status(400).json({error:"Informe a placa da carreta."});
  try{
    const r=await dbQuery(`
      UPDATE loads l SET plate=$1,trailer_plate=$1
      WHERE UPPER(BTRIM(l.transport)) IN (
        SELECT DISTINCT UPPER(BTRIM(s.transport)) FROM loads s WHERE s.id=ANY($2::bigint[])
      )
      RETURNING l.id
    `,[plate,ids]);
    res.json({ok:true,updated:r.rowCount,plate});
  }catch(e){console.error(e);res.status(500).json({error:"Não foi possível alocar os transportes."});}
});

app.post("/api/loads/unallocate",auth,roles("ADMIN","CARGAS"),async(req,res)=>{
  const ids=[...new Set((Array.isArray(req.body?.ids)?req.body.ids:[]).map(Number).filter(n=>Number.isSafeInteger(n)&&n>0))];
  if(!ids.length)return res.status(400).json({error:"Selecione pelo menos um transporte."});
  try{
    const r=await dbQuery(`
      UPDATE loads l SET plate='',trailer_plate=''
      WHERE UPPER(BTRIM(l.transport)) IN (
        SELECT DISTINCT UPPER(BTRIM(s.transport)) FROM loads s WHERE s.id=ANY($1::bigint[])
      )
        AND (COALESCE(BTRIM(l.plate),'')<>'' OR COALESCE(BTRIM(l.trailer_plate),'')<>'')
      RETURNING l.id
    `,[ids]);
    res.json({ok:true,updated:r.rowCount,ids:r.rows.map(x=>Number(x.id))});
  }catch(e){console.error(e);res.status(500).json({error:"Não foi possível desalocar os transportes."});}
});

app.delete("/api/loads/:id",auth,roles("ADMIN"),async(req,res)=>{
  const client=await pool.connect();
  try{
    await client.query("BEGIN");

    const lr=await client.query(
      "SELECT id,transport,status FROM loads WHERE id=$1",
      [req.params.id]
    );
    const l=lr.rows[0];
    if(!l){
      await client.query("ROLLBACK");
      return res.status(404).json({error:"Carga não encontrada"});
    }

    // audit.load_id não possui ON DELETE CASCADE, então removemos os
    // registros de auditoria ligados à carga antes de apagar a carga.
    await client.query("DELETE FROM audit WHERE load_id=$1",[l.id]);
    // items.load_id possui ON DELETE CASCADE e será removido junto.
    await client.query("DELETE FROM loads WHERE id=$1",[l.id]);

    await client.query("COMMIT");
    res.json({ok:true});
  }catch(e){
    await client.query("ROLLBACK");
    console.error(e);
    res.status(500).json({error:"Não foi possível excluir a carga"});
  }finally{
    client.release();
  }
});

app.post("/api/loads/:id/reopen",auth,roles("ADMIN"),async(req,res)=>{
  try{
    const lr=await dbQuery("SELECT id,transport,status,conferer_id FROM loads WHERE id=$1",[req.params.id]);
    const l=lr.rows[0];

    if(!l)return res.status(404).json({error:"Carga não encontrada"});
    if(l.status!=="EM_CONFERENCIA"){
      return res.status(400).json({error:"Somente cargas em conferência podem ser reabertas"});
    }

    await dbQuery(`
      UPDATE loads
      SET status='PENDENTE',
          started_at=NULL,
          finished_at=NULL,
          conferer_id=NULL
      WHERE id=$1
    `,[l.id]);

    await audit(req.user.id,"REABRIU_CARGA_PARA_NOVO_CONFERENTE",Number(l.id));
    res.json({ok:true});
  }catch(e){
    console.error(e);
    res.status(500).json({error:"Não foi possível reabrir a carga"});
  }
});

app.post("/api/loads/:id/start",auth,roles("CONFERENTE"),async(req,res)=>{
  try{
    const lr=await dbQuery(
      "SELECT * FROM loads WHERE id=$1",
      [req.params.id]
    );
    const l=lr.rows[0];

    if(!l)return res.status(404).json({error:"Carga não encontrada"});

    if(l.status==="EM_CONFERENCIA" && Number(l.conferer_id)===Number(req.user.id)){
      return res.json({ok:true,continued:true});
    }

    const r=await dbQuery(`
      UPDATE loads
      SET status='EM_CONFERENCIA',started_at=NOW(),conferer_id=$1,last_seen_at=NOW()
      WHERE id=$2 AND status='PENDENTE'
      RETURNING id
    `,[req.user.id,req.params.id]);

    if(r.rowCount===0){
      const atualR=await dbQuery(`
        SELECT l.status,u.name AS conferer_name
        FROM loads l
        LEFT JOIN users u ON u.id=l.conferer_id
        WHERE l.id=$1
      `,[req.params.id]);
      const atual=atualR.rows[0];

      if(atual && atual.status==="EM_CONFERENCIA"){
        return res.status(409).json({
          error:`Esta carga já está em conferência por ${atual.conferer_name||"outro conferente"}`
        });
      }

      if(atual && atual.status==="CONCLUIDA"){
        return res.status(409).json({error:"Esta carga já foi concluída"});
      }

      return res.status(409).json({error:"Não foi possível assumir esta carga"});
    }

    await audit(req.user.id,"INICIOU_CONFERENCIA",Number(req.params.id));
    res.json({ok:true});

  }catch(e){
    console.error(e);
    res.status(500).json({error:"Erro interno do servidor"});
  }
});

app.post("/api/loads/:id/heartbeat",auth,roles("CONFERENTE"),async(req,res)=>{
  try{
    const r=await dbQuery(
      "UPDATE loads SET last_seen_at=NOW() WHERE id=$1 AND conferer_id=$2 AND status='EM_CONFERENCIA' RETURNING id,last_seen_at",
      [req.params.id,req.user.id]
    );
    if(!r.rowCount)return res.status(409).json({error:"A carga não está em conferência por você."});
    res.json({ok:true,id:Number(r.rows[0].id),last_seen_at:r.rows[0].last_seen_at});
  }catch(e){
    console.error(e);
    res.status(500).json({error:"Não foi possível atualizar a presença do conferente"});
  }
});

app.patch("/api/items/:id",auth,roles("CONFERENTE"),async(req,res)=>{
  try{
    const {shortage_boxes=0,shortage_units=0,checked=false}=req.body;
    const itemR=await dbQuery(`SELECT i.id,i.load_id,l.status,l.conferer_id FROM items i JOIN loads l ON l.id=i.load_id WHERE i.id=$1`,[req.params.id]);
    const item=itemR.rows[0];
    if(!item)return res.status(404).json({error:"Item não encontrado"});
    const editableStatus=item.status==="EM_CONFERENCIA" || item.status==="CONCLUIDA";
    if(!editableStatus || Number(item.conferer_id)!==Number(req.user.id))return res.status(403).json({error:"Você não é o conferente responsável por esta carga"});
    const checkedNow=!!checked;
    const checkedValue=checkedColumnType==="boolean"?checkedNow:(checkedNow?1:0);
    let updated;
    try{
      // Caminho normal: salva também data e usuário da conferência.
      updated=await dbQuery(`
        UPDATE items SET shortage_boxes=$1,shortage_units=$2,checked=$3,
          checked_at=CASE WHEN $4 THEN NOW() ELSE NULL END,
          checked_by=CASE WHEN $4 THEN $5 ELSE NULL END
        WHERE id=$6 RETURNING id,checked,checked_at,checked_by
      `,[shortage_boxes,shortage_units,checkedValue,checkedNow,req.user.id,req.params.id]);
    }catch(saveError){
      // Compatibilidade com bancos que ainda não possuem checked_at/checked_by
      // ou que possuem alguma restrição nessas colunas. Não fazemos nova
      // consulta ao information_schema: o tipo de checked já foi descoberto no boot.
      console.error("FALHA NO SALVAMENTO COMPLETO, usando compatibilidade:",saveError.message);
      updated=await dbQuery(`
        UPDATE items SET shortage_boxes=$1,shortage_units=$2,checked=$3
        WHERE id=$4 RETURNING id,checked
      `,[shortage_boxes,shortage_units,checkedValue,req.params.id]);
      if(updated.rows[0]){
        updated.rows[0].checked_at=checkedNow?new Date().toISOString():null;
        updated.rows[0].checked_by=checkedNow?req.user.id:null;
      }
    }
    // Auditoria continua, mas não bloqueia a resposta do clique.
    const auditAction=item.status==="CONCLUIDA"
      ? (checkedNow?"AJUSTOU_ITEM_APOS_FINALIZACAO":"DESFEZ_ITEM_APOS_FINALIZACAO")
      : (checkedNow?"CONFERIU_ITEM":"DESFEZ_CONFERENCIA_ITEM");
    audit(req.user.id,auditAction,item.load_id).catch(e=>console.error("AUDIT ITEM:",e));
    res.json({ok:true,...updated.rows[0]});
  }catch(e){console.error("ERRO AO ATUALIZAR ITEM:",e);res.status(500).json({error:"Não foi possível salvar a conferência.",detail:process.env.NODE_ENV==="production"?undefined:e.message});}
});

app.get("/api/loads/:id/occurrences",auth,async(req,res)=>{
  try{
    const r=await dbQuery(`SELECT id,load_id,type,sku,lot,boxes,units,notes,photo_data,origin_unit,cause,investigation_status,action_taken,created_at,created_by,client_uid FROM load_occurrences WHERE load_id=$1 ORDER BY id ASC`,[req.params.id]);
    res.json(r.rows);
  }catch(e){console.error(e);res.status(500).json({error:"Erro ao carregar ocorrências"});}
});

app.post("/api/loads/:id/occurrences",auth,roles("CONFERENTE"),async(req,res)=>{
  try{
    const lr=await dbQuery("SELECT * FROM loads WHERE id=$1 AND conferer_id=$2",[req.params.id,req.user.id]);
    const l=lr.rows[0];
    if(!l)return res.status(404).json({error:"Carga não encontrada ou não está com você"});
    if(!["EM_CONFERENCIA","CONCLUIDA"].includes(l.status))return res.status(400).json({error:"A carga não está disponível para ajuste"});
    const allowed=["SOBRA","AVARIA","INVERSAO","VENCIDO","LOTE","QUANTIDADE","OUTRO"];
    const type=String(req.body?.type||"").toUpperCase();
    if(!allowed.includes(type))return res.status(400).json({error:"Tipo de ocorrência inválido"});
    const sku=String(req.body?.sku||"").trim();
    const lot=String(req.body?.lot||"").trim();
    const boxes=Math.max(0,Number(req.body?.boxes)||0);
    const units=Math.max(0,Number(req.body?.units)||0);
    const notes=String(req.body?.notes||"").trim();
    const origin_unit=String(req.body?.origin_unit||"").trim();
    const cause=String(req.body?.cause||"").trim();
    const investigation_status=["EM_ANALISE","CONFIRMADA","NAO_IDENTIFICADA"].includes(String(req.body?.investigation_status||"EM_ANALISE").toUpperCase())?String(req.body?.investigation_status||"EM_ANALISE").toUpperCase():"EM_ANALISE";
    const action_taken=String(req.body?.action_taken||"").trim();
    const photo_data=String(req.body?.photo_data||"");
    const client_uid=String(req.body?.client_uid||"").trim();
    if(!sku)return res.status(400).json({error:"Informe o SKU da ocorrência"});
    if(boxes<=0 && units<=0)return res.status(400).json({error:"Informe a quantidade da ocorrência"});
    if(photo_data && photo_data.length>900000)return res.status(400).json({error:"A foto ficou muito grande. Tente outra imagem."});
    if(client_uid){
      const existing=await dbQuery(`SELECT id,load_id,type,sku,lot,boxes,units,notes,photo_data,origin_unit,cause,investigation_status,action_taken,created_at,created_by,client_uid FROM load_occurrences WHERE load_id=$1 AND client_uid=$2 LIMIT 1`,[l.id,client_uid]);
      if(existing.rows[0])return res.json(existing.rows[0]);
    }
    const r=await dbQuery(`INSERT INTO load_occurrences(load_id,type,sku,lot,boxes,units,notes,photo_data,origin_unit,cause,investigation_status,action_taken,created_by,client_uid) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id,load_id,type,sku,lot,boxes,units,notes,photo_data,origin_unit,cause,investigation_status,action_taken,created_at,created_by,client_uid`,[l.id,type,sku,lot,boxes,units,notes,photo_data,origin_unit,cause,investigation_status,action_taken,req.user.id,client_uid||null]);
    await audit(req.user.id,l.status==="CONCLUIDA"?"AJUSTOU_OCORRENCIA_APOS_FINALIZACAO_"+type:"REGISTROU_OCORRENCIA_"+type,Number(l.id));
    res.json(r.rows[0]);
  }catch(e){console.error(e);res.status(500).json({error:"Não foi possível salvar a ocorrência"});}
});

app.patch("/api/loads/:id/occurrences/:occId",auth,roles("ADMIN","CARGAS","CONFERENTE"),async(req,res)=>{
  try{
    const r=await dbQuery(`SELECT o.*,l.conferer_id,l.status FROM load_occurrences o JOIN loads l ON l.id=o.load_id WHERE o.id=$1 AND o.load_id=$2`,[req.params.occId,req.params.id]);
    const o=r.rows[0];if(!o)return res.status(404).json({error:"Ocorrência não encontrada"});
    if(req.user.role==="CONFERENTE"&&Number(o.conferer_id)!==Number(req.user.id))return res.status(403).json({error:"Você só pode editar ocorrências das suas próprias cargas"});
    if(!["EM_CONFERENCIA","CONCLUIDA"].includes(String(o.status||"").toUpperCase()))return res.status(400).json({error:"A carga não está disponível para ajuste"});
    const cause=Object.prototype.hasOwnProperty.call(req.body||{},"cause")?String(req.body.cause||"").trim():o.cause;
    const origin=Object.prototype.hasOwnProperty.call(req.body||{},"origin_unit")?String(req.body.origin_unit||"").trim():o.origin_unit;
    const action=Object.prototype.hasOwnProperty.call(req.body||{},"action_taken")?String(req.body.action_taken||"").trim():o.action_taken;
    const notes=Object.prototype.hasOwnProperty.call(req.body||{},"notes")?String(req.body.notes||"").trim():o.notes;
    const status=Object.prototype.hasOwnProperty.call(req.body||{},"investigation_status")?String(req.body.investigation_status||"EM_ANALISE").toUpperCase():o.investigation_status;
    if(!["EM_ANALISE","CONFIRMADA","NAO_IDENTIFICADA"].includes(status))return res.status(400).json({error:"Situação da investigação inválida"});
    const updated=await dbQuery(`UPDATE load_occurrences SET origin_unit=$1,cause=$2,investigation_status=$3,action_taken=$4,notes=$5 WHERE id=$6 AND load_id=$7 RETURNING id,load_id,type,sku,lot,boxes,units,notes,photo_data,origin_unit,cause,investigation_status,action_taken,created_at,created_by,client_uid`,[origin,cause,status,action,notes,o.id,o.load_id]);
    await audit(req.user.id,"ATUALIZOU_ANALISE_OCORRENCIA",Number(o.load_id));res.json(updated.rows[0]);
  }catch(e){console.error(e);res.status(500).json({error:"Não foi possível atualizar a análise da ocorrência"});}
});

app.delete("/api/loads/:id/occurrences/:occId",auth,roles("ADMIN","CARGAS","CONFERENTE"),async(req,res)=>{
  try{
    const r=await dbQuery(`SELECT o.*,l.conferer_id,l.status FROM load_occurrences o JOIN loads l ON l.id=o.load_id WHERE o.id=$1 AND o.load_id=$2`,[req.params.occId,req.params.id]);
    const o=r.rows[0];
    if(!o)return res.status(404).json({error:"Ocorrência não encontrada"});
    if(req.user.role==="CONFERENTE" && Number(o.conferer_id)!==Number(req.user.id))return res.status(403).json({error:"Você só pode excluir suas próprias ocorrências"});
    if(!["EM_CONFERENCIA","CONCLUIDA"].includes(o.status))return res.status(400).json({error:"Somente ocorrências de cargas em conferência ou concluídas podem ser ajustadas"});
    await dbQuery("DELETE FROM load_occurrences WHERE id=$1",[o.id]);
    res.json({ok:true});
  }catch(e){console.error(e);res.status(500).json({error:"Não foi possível excluir a ocorrência"});}
});


app.patch("/api/loads/:id/pallets",auth,roles("ADMIN","CARGAS","CONFERENTE"),async(req,res)=>{
  try{
    const r=await dbQuery("SELECT * FROM loads WHERE id=$1",[req.params.id]);
    const l=r.rows[0];
    if(!l)return res.status(404).json({error:"Carga não encontrada"});
    if(req.user.role==="CONFERENTE" && Number(l.conferer_id)!==Number(req.user.id))return res.status(403).json({error:"Você só pode ajustar suas próprias cargas"});
    if(!["EM_CONFERENCIA","CONCLUIDA"].includes(String(l.status||'').toUpperCase()))return res.status(400).json({error:"A carga não está disponível para ajuste"});
    const palletSeco=Math.max(0,Number(req.body?.pallet_seco)||0);
    const palletRefri=Math.max(0,Number(req.body?.pallet_refri)||0);
    const palletTotal=palletSeco+palletRefri;
    const u=await dbQuery(`UPDATE loads SET pallet_seco=$1,pallet_refri=$2,pallet_total=$3 WHERE id=$4 RETURNING pallet_seco,pallet_refri,pallet_total`,[palletSeco,palletRefri,palletTotal,l.id]);
    await audit(req.user.id,"AJUSTOU_PALLETS_APOS_FINALIZACAO",Number(l.id));
    res.json({ok:true,...u.rows[0]});
  }catch(e){console.error(e);res.status(500).json({error:"Não foi possível salvar os pallets"});}
});

app.post("/api/loads/:id/sync-offline",auth,roles("CONFERENTE"),async(req,res)=>{
  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    const lr=await client.query("SELECT * FROM loads WHERE id=$1 AND conferer_id=$2 FOR UPDATE",[req.params.id,req.user.id]);
    const l=lr.rows[0];
    if(!l){await client.query("ROLLBACK");return res.status(404).json({error:"Carga não encontrada ou não está com você"});}
    if(!["EM_CONFERENCIA","CONCLUIDA"].includes(l.status)){await client.query("ROLLBACK");return res.status(400).json({error:"A carga não está disponível para ajuste"});}
    const items=Array.isArray(req.body?.items)?req.body.items:[];
    const occurrences=Array.isArray(req.body?.occurrences)?req.body.occurrences:[];
    const palletSeco=Math.max(0,Number(req.body?.pallets?.pallet_seco)||0);
    const palletRefri=Math.max(0,Number(req.body?.pallets?.pallet_refri)||0);
    const palletTotal=palletSeco+palletRefri;
    const finish=!!req.body?.finish;
    for(const item of items){
      const id=Number(item?.id);if(!id)continue;
      const checked=!!item?.checked;
      const shortageBoxes=Math.max(0,Number(item?.shortage_boxes)||0);
      const shortageUnits=Math.max(0,Number(item?.shortage_units)||0);
      const checkedExpr=checkedColumnType==="boolean"?"$3::boolean":"CASE WHEN $3::boolean THEN 1 ELSE 0 END";
      const updatedItem=await client.query(`UPDATE items SET shortage_boxes=$1,shortage_units=$2,checked=${checkedExpr},checked_at=CASE WHEN $3::boolean THEN COALESCE(checked_at,NOW()) ELSE NULL END,checked_by=CASE WHEN $3::boolean THEN COALESCE(checked_by,$4) ELSE NULL END WHERE id=$5 AND load_id=$6 RETURNING id`,[shortageBoxes,shortageUnits,checked,req.user.id,id,l.id]);
      if(updatedItem.rowCount===0){
        await client.query("ROLLBACK");
        return res.status(409).json({error:"Um dos itens da sincronização não pertence mais a esta carga. A sincronização foi cancelada para evitar sobrescrever dados."});
      }
    }
    for(const o of occurrences){
      const uid=String(o?.client_uid||"").trim(),type=String(o?.type||"").toUpperCase(),sku=String(o?.sku||"").trim(),lot=String(o?.lot||"").trim(),notes=String(o?.notes||"").trim(),photoData=String(o?.photo_data||""),originUnit=String(o?.origin_unit||"").trim(),cause=String(o?.cause||"").trim(),investigationStatus=["EM_ANALISE","CONFIRMADA","NAO_IDENTIFICADA"].includes(String(o?.investigation_status||"EM_ANALISE").toUpperCase())?String(o?.investigation_status||"EM_ANALISE").toUpperCase():"EM_ANALISE",actionTaken=String(o?.action_taken||"").trim();
      const boxes=Math.max(0,Number(o?.boxes)||0),units=Math.max(0,Number(o?.units)||0);
      if(!uid||!["SOBRA","AVARIA","INVERSAO","VENCIDO","LOTE","QUANTIDADE","OUTRO"].includes(type)||!sku||boxes<=0&&units<=0||photoData.length>900000)continue;
      const existing=await client.query("SELECT id FROM load_occurrences WHERE load_id=$1 AND client_uid=$2 LIMIT 1",[l.id,uid]);
      if(existing.rows[0])continue;
      await client.query(`INSERT INTO load_occurrences(load_id,type,sku,lot,boxes,units,notes,photo_data,origin_unit,cause,investigation_status,action_taken,created_by,client_uid) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,[l.id,type,sku,lot,boxes,units,notes,photoData,originUnit,cause,investigationStatus,actionTaken,req.user.id,uid]);
    }
    await client.query("UPDATE loads SET pallet_seco=$1,pallet_refri=$2,pallet_total=$3,last_seen_at=NOW() WHERE id=$4",[palletSeco,palletRefri,palletTotal,l.id]);
    if(finish){
      const pendingCondition=checkedColumnType==="boolean"?"checked=false":"checked=0";
      const pr=await client.query(`SELECT COUNT(*)::int AS n FROM items WHERE load_id=$1 AND ${pendingCondition}`,[l.id]);
      const n=pr.rows[0]?.n||0;
      if(n){await client.query("ROLLBACK");return res.status(400).json({error:`Ainda faltam ${n} item(ns) para conferir`});}
      await client.query("UPDATE loads SET status='CONCLUIDA',finished_at=NOW(),last_seen_at=NOW() WHERE id=$1",[l.id]);
      await client.query("INSERT INTO audit(user_id,action,load_id,at) VALUES($1,$2,$3,NOW())",[req.user.id,"FINALIZOU_CONFERENCIA_OFFLINE",Number(l.id)]);
    }
    const freshLoad=(await client.query(`SELECT l.*,u.name AS conferer_name FROM loads l LEFT JOIN users u ON u.id=l.conferer_id WHERE l.id=$1`,[l.id])).rows[0];
    const freshItems=(await client.query(`SELECT id,sku,product,lot,boxes,fraction,gross_weight,shortage_boxes,shortage_units,checked,checked_at,checked_by FROM items WHERE load_id=$1 ORDER BY id ASC`,[l.id])).rows;
    const freshOcc=(await client.query(`SELECT id,load_id,type,sku,lot,boxes,units,notes,photo_data,origin_unit,cause,investigation_status,action_taken,created_at,created_by,client_uid FROM load_occurrences WHERE load_id=$1 ORDER BY id ASC`,[l.id])).rows;
    await client.query("COMMIT");
    res.json({ok:true,load:freshLoad,items:freshItems,occurrences:freshOcc});
  }catch(e){try{await client.query("ROLLBACK")}catch(_){};console.error(e);res.status(500).json({error:"Não foi possível sincronizar os dados offline",detail:process.env.NODE_ENV==="production"?undefined:e.message});}
  finally{client.release();}
});

async function getTransportChecklistByLoad(loadId){
  const base=await dbQuery(`SELECT l.*,u.name AS conferer_name FROM loads l LEFT JOIN users u ON u.id=l.conferer_id WHERE l.id=$1`,[loadId]);
  const target=base.rows[0];if(!target)return null;
  const dateRow=await dbQuery(`SELECT (COALESCE(finished_at,started_at,created_at) AT TIME ZONE 'America/Sao_Paulo')::date AS check_date FROM loads WHERE id=$1`,[target.id]);
  const checkDate=String(dateRow.rows[0]?.check_date||"");

  // O checklist é consolidado pelo NÚMERO DO TRANSPORTE, não por um único picking.
  // Usamos TRIM para evitar que espaços invisíveis no cadastro do transporte
  // façam um cliente ficar fora da consolidação.
  const r=await dbQuery(`
    SELECT l.id,l.transport,l.client,l.plate,l.truck_plate,l.trailer_plate,l.status,l.pallet_seco,l.pallet_refri,l.pallet_total,l.started_at,l.finished_at,u.name AS conferer_name,
      COALESCE(ic.item_total,0)::int AS item_total,
      COALESCE(ic.item_checked,0)::int AS item_checked,
      COALESCE(ic.gross_weight_total,0)::numeric AS gross_weight_total
    FROM loads l
    LEFT JOIN users u ON u.id=l.conferer_id
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS item_total,
             COUNT(*) FILTER (WHERE ${checkedColumnType==="boolean"?"i.checked=true":"i.checked<>0"})::int AS item_checked,
             COALESCE(SUM(i.gross_weight),0) AS gross_weight_total
      FROM items i WHERE i.load_id=l.id
    ) ic ON true
    WHERE TRIM(l.transport)=TRIM($1)
    ORDER BY l.id ASC
  `,[target.transport]);

  const loads=r.rows;
  const isCompleted=x=>String(x.status||'').trim().toUpperCase()==="CONCLUIDA" && Number(x.item_total)>0 && Number(x.item_checked)===Number(x.item_total);
  const completedLoads=loads.filter(isCompleted);
  const pendingLoads=loads.filter(x=>!isCompleted(x));
  const complete=loads.length>0&&pendingLoads.length===0;
  const totals=loads.reduce((a,x)=>{
    a.pallet_seco+=Number(x.pallet_seco||0);
    a.pallet_refri+=Number(x.pallet_refri||0);
    a.pallet_total+=Number(x.pallet_total||((x.pallet_seco||0)+(x.pallet_refri||0)));
    a.totalPesoBruto+=Number(x.gross_weight_total||0);
    return a;
  },{pallet_seco:0,pallet_refri:0,pallet_total:0,totalPesoBruto:0});

  // O controle de impressão é complementar. Se a tabela de histórico não
  // existir na base antiga (ou estiver com estrutura diferente), isso NÃO pode
  // impedir o sistema de reconhecer que todos os pickings foram concluídos.
  let printed=null;
  try{
    const pr=await dbQuery(`
      SELECT tc.printed_at,tc.printed_by,u.name AS printed_by_name
      FROM transport_checklists tc
      LEFT JOIN users u ON u.id=tc.printed_by
      WHERE TRIM(tc.transport)=TRIM($1)
      ORDER BY CASE WHEN tc.check_date=$2::date THEN 0 ELSE 1 END, tc.check_date DESC
      LIMIT 1
    `,[target.transport,checkDate]);
    printed=pr.rows[0]||null;
  }catch(e){
    console.warn('CHECKLIST PRINT HISTORY: usando somente o status calculado pelas cargas:',e.message);
  }

  return {
    transport:String(target.transport||'').trim(),
    check_date:checkDate,
    complete,
    total_loads:loads.length,
    completed_loads:completedLoads.length,
    pending_loads:pendingLoads.length,
    loads,
    totals,
    printed_at:printed?.printed_at||null,
    printed_by:printed?.printed_by||null,
    printed_by_name:printed?.printed_by_name||null
  };
}
app.get("/api/loads/:id/transport-checklist",auth,roles("ADMIN","CARGAS","CONFERENTE"),async(req,res)=>{try{const data=await getTransportChecklistByLoad(req.params.id);if(!data)return res.status(404).json({error:"Carga não encontrada"});res.json(data);}catch(e){console.error(e);res.status(500).json({error:"Não foi possível consultar o checklist do transporte"});}});

app.get("/api/loads/:id/transport-report",auth,roles("ADMIN","CARGAS","CONFERENTE"),async(req,res)=>{
  try{
    const checklist=await getTransportChecklistByLoad(req.params.id);
    if(!checklist)return res.status(404).json({error:"Carga não encontrada"});
    if(!checklist.complete)return res.status(400).json({error:"O relatório consolidado só fica disponível quando todos os pickings do transporte estiverem concluídos"});

    const loadIds=checklist.loads.map(x=>Number(x.id)).filter(Boolean);
    if(!loadIds.length)return res.status(404).json({error:"Nenhum picking encontrado para este transporte"});

    const ir=await dbQuery(`
      SELECT id,load_id,sku,product,lot,boxes,fraction,gross_weight,shortage_boxes,shortage_units,checked,checked_at,checked_by
      FROM items
      WHERE load_id = ANY($1::bigint[])
      ORDER BY load_id ASC,id ASC
    `,[loadIds]);

    const or=await dbQuery(`
      SELECT id,load_id,type,sku,lot,boxes,units,notes,photo_data,created_at,created_by,client_uid
      FROM load_occurrences
      WHERE load_id = ANY($1::bigint[])
      ORDER BY load_id ASC,id ASC
    `,[loadIds]);

    const reports=checklist.loads.map(load=>{
      const items=ir.rows.filter(i=>Number(i.load_id)===Number(load.id));
      const occurrences=or.rows.filter(o=>Number(o.load_id)===Number(load.id));
      const faults=items.filter(i=>Number(i.shortage_boxes||0)>0 || Number(i.shortage_units||0)>0);
      const totalCx=items.reduce((a,i)=>a+Number(i.boxes||0),0);
      const totalFrac=items.reduce((a,i)=>a+Number(i.fraction||0),0);
      const totalPesoBruto=items.reduce((a,i)=>a+Number(i.gross_weight||0),0);
      const faltCx=faults.reduce((a,i)=>a+Number(i.shortage_boxes||0),0);
      const faltUn=faults.reduce((a,i)=>a+Number(i.shortage_units||0),0);
      return {
        load,
        items,
        faults,
        occurrences,
        summary:{
          items:items.length,
          conferidos:items.filter(i=>Number(i.checked)).length,
          totalCx,totalFrac,totalPesoBruto,faltCx,faltUn,faltItens:faults.length
        }
      };
    });

    res.json({
      transport:checklist.transport,
      check_date:checklist.check_date,
      complete:checklist.complete,
      total_loads:checklist.total_loads,
      completed_loads:checklist.completed_loads,
      loads:checklist.loads,
      totals:checklist.totals,
      printed_at:checklist.printed_at,
      printed_by:checklist.printed_by,
      printed_by_name:checklist.printed_by_name,
      reports
    });
  }catch(e){
    console.error(e);
    res.status(500).json({error:"Não foi possível montar o relatório consolidado do transporte"});
  }
});

app.post("/api/loads/:id/transport-checklist/print",auth,roles("ADMIN","CARGAS","CONFERENTE"),async(req,res)=>{
  try{
    const data=await getTransportChecklistByLoad(req.params.id);
    if(!data)return res.status(404).json({error:"Carga não encontrada"});
    if(!data.complete)return res.status(400).json({error:"O checklist só fica disponível quando todos os clientes do transporte estiverem concluídos"});
    let tracked=false;
    try{
      await dbQuery(`INSERT INTO transport_checklists(check_date,transport,printed_at,printed_by) VALUES($1::date,$2,NOW(),$3) ON CONFLICT(check_date,transport) DO UPDATE SET printed_at=NOW(),printed_by=EXCLUDED.printed_by`,[data.check_date,data.transport,req.user.id]);
      tracked=true;
    }catch(e){
      console.warn('CHECKLIST PRINT HISTORY: não foi possível gravar histórico de impressão:',e.message);
    }
    await dbQuery(`UPDATE loads SET loading_ready_at=COALESCE(loading_ready_at,NOW()),loading_status=COALESCE(loading_status,'PENDENTE') WHERE UPPER(BTRIM(transport))=UPPER(BTRIM($1::text)) AND status='CONCLUIDA' AND (COALESCE(finished_at,started_at,created_at) AT TIME ZONE 'America/Sao_Paulo')::date=$2::date`,[data.transport,data.check_date]);
    await audit(req.user.id,"IMPRIMIU_CHECKLIST_TRANSPORTE",Number(req.params.id));
    res.json({ok:true,tracked});
  }catch(e){
    console.error(e);
    res.status(500).json({error:"Não foi possível registrar a impressão do checklist"});
  }
});

app.post("/api/loads/:id/finish",auth,roles("CONFERENTE"),async(req,res)=>{
  try{
    const lr=await dbQuery(
      "SELECT * FROM loads WHERE id=$1 AND conferer_id=$2",
      [req.params.id,req.user.id]
    );
    const l=lr.rows[0];

    if(!l)return res.status(404).json({error:"Carga não encontrada"});

    const typeResult=await dbQuery(`
      SELECT data_type
      FROM information_schema.columns
      WHERE table_schema='public'
        AND table_name='items'
        AND column_name='checked'
      LIMIT 1
    `);
    const checkedType=typeResult.rows[0]?.data_type||"integer";
    const pendingCondition=checkedType==="boolean" ? "checked=false" : "checked=0";

    const nr=await dbQuery(
      `SELECT COUNT(*)::int AS n FROM items WHERE load_id=$1 AND ${pendingCondition}`,
      [l.id]
    );
    const n=nr.rows[0].n;

    if(n)return res.status(400).json({
      error:`Ainda faltam ${n} item(ns) para conferir`
    });

    const palletSeco=Math.max(0,Number(req.body?.pallet_seco)||0);
    const palletRefri=Math.max(0,Number(req.body?.pallet_refri)||0);
    const palletTotal=palletSeco+palletRefri;

    await dbQuery(
      `UPDATE loads
       SET status='CONCLUIDA',finished_at=NOW(),last_seen_at=NOW(),
           pallet_seco=$1,pallet_refri=$2,pallet_total=$3
       WHERE id=$4`,
      [palletSeco,palletRefri,palletTotal,l.id]
    );

    await audit(req.user.id,"FINALIZOU_CONFERENCIA",Number(l.id));
    res.json({ok:true});

  }catch(e){
    console.error(e);
    res.status(500).json({error:"Erro interno do servidor"});
  }
});

app.get("/api/dashboard-summary",auth,roles("ADMIN","CARGAS"),async(req,res)=>{
  try{
    const today=String(req.query.date||new Date().toLocaleDateString("en-CA",{timeZone:"America/Sao_Paulo"})).slice(0,10);
    const month=String(req.query.month||today.slice(0,7)).slice(0,7);
    const mode=String(req.query.mode||"day")==="night"?"night":"day";
    if(!/^\d{4}-\d{2}-\d{2}$/.test(today)||!/^\d{4}-\d{2}$/.test(month))
      return res.status(400).json({error:"Data inválida"});
    const [yy,mm]=month.split("-").map(Number);
    const nextMonth=new Date(Date.UTC(yy,mm,1));
    const nextMonthKey=nextMonth.toISOString().slice(0,10);

    const dailyR=await dbQuery(`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE status='PENDENTE')::int AS pending,
        COUNT(*) FILTER (WHERE status='EM_CONFERENCIA')::int AS doing,
        COUNT(*) FILTER (WHERE status='CONCLUIDA')::int AS done,
        COUNT(*) FILTER (
          WHERE EXISTS (
            SELECT 1 FROM items i WHERE i.load_id=l.id
              AND (COALESCE(i.shortage_boxes,0)>0 OR COALESCE(i.shortage_units,0)>0)
          ) OR EXISTS (
            SELECT 1 FROM load_occurrences o WHERE o.load_id=l.id
          )
        )::int AS div
      FROM loads l
      WHERE (
        ($2::text='day' AND (l.created_at AT TIME ZONE 'America/Sao_Paulo')::date=$1::date)
        OR
        ($2::text='night'
          AND (l.created_at AT TIME ZONE 'America/Sao_Paulo') >= ($1::date + TIME '20:00')
          AND (l.created_at AT TIME ZONE 'America/Sao_Paulo') < (($1::date + 1) + TIME '05:48'))
      )
    `,[today,mode]);

    const activeR=await dbQuery(`
      SELECT l.id,l.transport,l.client,l.status,l.last_seen_at,u.name AS conferer_name,
        COALESCE(ic.item_total,0)::int AS item_total,
        COALESCE(ic.item_checked,0)::int AS item_checked
      FROM loads l
      LEFT JOIN users u ON u.id=l.conferer_id
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS item_total,COUNT(*) FILTER (WHERE ${checkedColumnType==="boolean"?"i.checked=true":"i.checked<>0"})::int AS item_checked
        FROM items i WHERE i.load_id=l.id
      ) ic ON true
      WHERE (
        ($2::text='day' AND (l.created_at AT TIME ZONE 'America/Sao_Paulo')::date=$1::date)
        OR
        ($2::text='night'
          AND (l.created_at AT TIME ZONE 'America/Sao_Paulo') >= ($1::date + TIME '20:00')
          AND (l.created_at AT TIME ZONE 'America/Sao_Paulo') < (($1::date + 1) + TIME '05:48'))
      )
        AND l.status='EM_CONFERENCIA'
      ORDER BY l.started_at ASC NULLS LAST,l.id ASC
    `,[today,mode]);

    const monthlyR=await dbQuery(`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE status='CONCLUIDA')::int AS done,
        COUNT(*) FILTER (WHERE status='EM_CONFERENCIA')::int AS doing,
        COUNT(*) FILTER (WHERE status='PENDENTE')::int AS pending,
        COUNT(*) FILTER (
          WHERE EXISTS (
            SELECT 1 FROM items i WHERE i.load_id=l.id
              AND (COALESCE(i.shortage_boxes,0)>0 OR COALESCE(i.shortage_units,0)>0)
          ) OR EXISTS (SELECT 1 FROM load_occurrences o WHERE o.load_id=l.id)
        )::int AS div
      FROM loads l
      WHERE (l.created_at AT TIME ZONE 'America/Sao_Paulo')::date >= $1::date
        AND (l.created_at AT TIME ZONE 'America/Sao_Paulo')::date < $2::date
    `,[month+'-01',nextMonthKey]);

    const monthlyPeople=await dbQuery(`
      SELECT u.id,u.name,COUNT(l.id)::int AS cargas,
        COALESCE(SUM(EXTRACT(EPOCH FROM (l.finished_at-l.started_at))/60),0)::numeric AS total_minutos,
        COALESCE(AVG(EXTRACT(EPOCH FROM (l.finished_at-l.started_at))/60),0)::numeric AS media_minutos,
        COALESCE(SUM(x.itens),0)::int AS itens,
        COALESCE(SUM(x.caixas),0) AS caixas,
        COALESCE(SUM(x.fracao),0) AS fracao
      FROM users u
      JOIN loads l ON l.conferer_id=u.id
        AND l.status='CONCLUIDA'
        AND l.finished_at IS NOT NULL
        AND l.started_at IS NOT NULL
        AND (l.finished_at AT TIME ZONE 'America/Sao_Paulo')::date >= $1::date
        AND (l.finished_at AT TIME ZONE 'America/Sao_Paulo')::date < $2::date
      LEFT JOIN LATERAL (
        SELECT COUNT(*) AS itens,COALESCE(SUM(boxes),0) AS caixas,COALESCE(SUM(fraction),0) AS fracao
        FROM items i WHERE i.load_id=l.id
      ) x ON true
      GROUP BY u.id,u.name
      ORDER BY caixas DESC,u.name ASC
    `,[month+'-01',nextMonthKey]);

    const monthlyTotalsR=await dbQuery(`
      SELECT
        COALESCE(SUM(EXTRACT(EPOCH FROM (l.finished_at-l.started_at))/60),0)::numeric AS total_minutos,
        COALESCE(AVG(EXTRACT(EPOCH FROM (l.finished_at-l.started_at))/60),0)::numeric AS media_minutos
      FROM loads l
      WHERE l.status='CONCLUIDA'
        AND l.finished_at IS NOT NULL
        AND l.started_at IS NOT NULL
        AND (l.finished_at AT TIME ZONE 'America/Sao_Paulo')::date >= $1::date
        AND (l.finished_at AT TIME ZONE 'America/Sao_Paulo')::date < $2::date
    `,[month+'-01',nextMonthKey]);

    const toClientRow=x=>{
      const lastSeenMs=x.last_seen_at?new Date(x.last_seen_at).getTime():NaN;
      return {...x,id:Number(x.id),item_total:Number(x.item_total||0),item_checked:Number(x.item_checked||0),progress_pct:Number(x.item_total||0)?Math.round(Number(x.item_checked||0)/Number(x.item_total||1)*100):0,conferer_online:Number.isFinite(lastSeenMs)&&(Date.now()-lastSeenMs)<=45000,last_seen_at:x.last_seen_at||null};
    };
    const d=dailyR.rows[0]||{total:0,pending:0,doing:0,done:0,div:0};
    const m=monthlyR.rows[0]||{total:0,done:0,doing:0,pending:0,div:0};
    const mt=monthlyTotalsR.rows[0]||{total_minutos:0,media_minutos:0};
    res.json({
      today:{date:today,mode,total:Number(d.total||0),pending:Number(d.pending||0),doing:Number(d.doing||0),done:Number(d.done||0),div:Number(d.div||0),active_loads:activeR.rows.map(toClientRow)},
      month:{month,total:Number(m.total||0),pending:Number(m.pending||0),doing:Number(m.doing||0),done:Number(m.done||0),div:Number(m.div||0),total_minutos:Number(mt.total_minutos||0),media_minutos:Number(mt.media_minutos||0),conferers:monthlyPeople.rows.map(x=>({...x,id:Number(x.id),cargas:Number(x.cargas||0),itens:Number(x.itens||0),caixas:Number(x.caixas||0),fracao:Number(x.fracao||0),total_minutos:Number(x.total_minutos||0),media_minutos:Number(x.media_minutos||0)}))}
    });
  }catch(e){
    console.error(e);
    res.status(500).json({error:"Não foi possível carregar o painel de gestão"});
  }
});

app.get("/api/dashboard-history",auth,roles("ADMIN","CARGAS"),async(req,res)=>{
  try{
    const today=new Date().toLocaleDateString("en-CA",{timeZone:"America/Sao_Paulo"});
    const from=String(req.query.from||today).slice(0,10);
    const to=String(req.query.to||today).slice(0,10);
    if(!/^\d{4}-\d{2}-\d{2}$/.test(from)||!/^\d{4}-\d{2}-\d{2}$/.test(to)||from>to)
      return res.status(400).json({error:"Período inválido."});
    const totals=await dbQuery(`
      SELECT COUNT(*)::int AS transports,
        COUNT(*) FILTER(WHERE l.status='CONCLUIDA')::int AS completed,
        COUNT(*) FILTER(WHERE l.status='EM_CONFERENCIA')::int AS in_progress,
        COUNT(*) FILTER(WHERE l.status='PENDENTE')::int AS pending,
        COALESCE(SUM(CASE WHEN l.status='CONCLUIDA' THEN COALESCE(w.weight,0) ELSE 0 END),0)::numeric AS gross_weight,
        COALESCE(SUM(CASE WHEN l.status='CONCLUIDA' AND l.started_at IS NOT NULL AND l.finished_at IS NOT NULL THEN EXTRACT(EPOCH FROM(l.finished_at-l.started_at))/60 ELSE 0 END),0)::numeric AS total_minutes,
        COALESCE(AVG(CASE WHEN l.status='CONCLUIDA' AND l.started_at IS NOT NULL AND l.finished_at IS NOT NULL THEN EXTRACT(EPOCH FROM(l.finished_at-l.started_at))/60 END),0)::numeric AS avg_minutes
      FROM loads l LEFT JOIN LATERAL(SELECT SUM(i.gross_weight) AS weight FROM items i WHERE i.load_id=l.id) w ON true
      WHERE (COALESCE(l.finished_at,l.started_at,l.created_at) AT TIME ZONE 'America/Sao_Paulo')::date >= $1::date
        AND (COALESCE(l.finished_at,l.started_at,l.created_at) AT TIME ZONE 'America/Sao_Paulo')::date <= $2::date
    `,[from,to]);
    const people=await dbQuery(`
      SELECT u.name,COUNT(*)::int AS transports,
        COALESCE(SUM(w.weight),0)::numeric AS gross_weight,
        COALESCE(SUM(w.boxes),0)::numeric AS boxes,
        COALESCE(SUM(EXTRACT(EPOCH FROM(l.finished_at-l.started_at))/60),0)::numeric AS total_minutes,
        COALESCE(AVG(EXTRACT(EPOCH FROM(l.finished_at-l.started_at))/60),0)::numeric AS avg_minutes
      FROM loads l JOIN users u ON u.id=l.conferer_id
      LEFT JOIN LATERAL(SELECT SUM(i.gross_weight) AS weight,SUM(i.boxes) AS boxes FROM items i WHERE i.load_id=l.id) w ON true
      WHERE l.status='CONCLUIDA' AND l.finished_at IS NOT NULL AND l.started_at IS NOT NULL
        AND (l.finished_at AT TIME ZONE 'America/Sao_Paulo')::date >= $1::date
        AND (l.finished_at AT TIME ZONE 'America/Sao_Paulo')::date <= $2::date
      GROUP BY u.id,u.name ORDER BY transports DESC,u.name
    `,[from,to]);
    const days=await dbQuery(`
      SELECT (l.finished_at AT TIME ZONE 'America/Sao_Paulo')::date::text AS day,COUNT(*)::int AS transports,
        COALESCE(SUM(w.weight),0)::numeric AS gross_weight
      FROM loads l LEFT JOIN LATERAL(SELECT SUM(i.gross_weight) AS weight FROM items i WHERE i.load_id=l.id) w ON true
      WHERE l.status='CONCLUIDA' AND l.finished_at IS NOT NULL
        AND (l.finished_at AT TIME ZONE 'America/Sao_Paulo')::date >= $1::date
        AND (l.finished_at AT TIME ZONE 'America/Sao_Paulo')::date <= $2::date
      GROUP BY day ORDER BY day
    `,[from,to]);
    const t=totals.rows[0]||{};
    res.json({from,to,totals:{transports:Number(t.transports||0),completed:Number(t.completed||0),in_progress:Number(t.in_progress||0),pending:Number(t.pending||0),gross_weight:Number(t.gross_weight||0),total_minutes:Number(t.total_minutes||0),avg_minutes:Number(t.avg_minutes||0)},people:people.rows.map(x=>({...x,transports:Number(x.transports||0),gross_weight:Number(x.gross_weight||0),boxes:Number(x.boxes||0),total_minutes:Number(x.total_minutes||0),avg_minutes:Number(x.avg_minutes||0)})),days:days.rows.map(x=>({...x,transports:Number(x.transports||0),gross_weight:Number(x.gross_weight||0)}))});
  }catch(e){console.error(e);res.status(500).json({error:"Não foi possível carregar o histórico do painel."});}
});

app.get("/api/ranking",auth,roles("ADMIN","CARGAS"),async(req,res)=>{
  try{
    const r=await dbQuery(`
      SELECT u.name,COUNT(l.id)::int AS cargas,
        COALESCE(SUM(x.itens),0)::int AS itens,
        COALESCE(SUM(x.caixas),0) AS caixas,
        COALESCE(SUM(x.fracao),0) AS fracao,
        ROUND(AVG(EXTRACT(EPOCH FROM (l.finished_at-l.started_at))/60))::int AS tempo_medio
      FROM users u JOIN loads l ON l.conferer_id=u.id AND l.status='CONCLUIDA'
      LEFT JOIN LATERAL (SELECT COUNT(*) AS itens,COALESCE(SUM(boxes),0) AS caixas,COALESCE(SUM(fraction),0) AS fracao FROM items i WHERE i.load_id=l.id) x ON true
      GROUP BY u.id,u.name ORDER BY caixas DESC
    `);
    res.json(r.rows);
  }catch(e){console.error(e);res.status(500).json({error:"Erro interno do servidor"});}
});

app.post("/api/loads/:id/correct",auth,roles("ADMIN","CARGAS","CONFERENTE"),async(req,res)=>{
  try{
    const lr=await dbQuery("SELECT * FROM loads WHERE id=$1",[req.params.id]);
    const l=lr.rows[0];
    if(!l)return res.status(404).json({error:"Carga não encontrada"});
    if(l.status!=="CONCLUIDA")return res.status(400).json({error:"Somente cargas concluídas podem ser corrigidas"});
    if(req.user.role==="CONFERENTE" && Number(l.conferer_id)!==Number(req.user.id))return res.status(403).json({error:"Você só pode corrigir suas próprias cargas"});
    await dbQuery("UPDATE loads SET status='EM_CONFERENCIA',started_at=NOW(),finished_at=NULL,last_seen_at=NOW() WHERE id=$1",[l.id]);
    await audit(req.user.id,"REABRIU_PARA_CORRECAO",Number(l.id));
    res.json({ok:true,conferer_id:l.conferer_id});
  }catch(e){console.error(e);res.status(500).json({error:"Não foi possível reabrir a carga para correção"});}
});

app.get("/api/loads/:id/report",auth,async(req,res)=>{
  try{
    const lr=await dbQuery(`
      SELECT l.*,u.name AS conferer_name
      FROM loads l
      LEFT JOIN users u ON u.id=l.conferer_id
      WHERE l.id=$1
    `,[req.params.id]);

    const l=lr.rows[0];
    if(!l)return res.status(404).json({error:"Não encontrado"});

    const items=await dbQuery(`
      SELECT id,sku,product,lot,boxes,fraction,gross_weight,shortage_boxes,shortage_units,checked,checked_at,checked_by
      FROM items
      WHERE load_id=$1
      ORDER BY id ASC
    `,[l.id]);

    const faults=items.rows.filter(i=>Number(i.shortage_boxes||0)>0 || Number(i.shortage_units||0)>0);
    const occurrences=await dbQuery(`SELECT id,load_id,type,sku,lot,boxes,units,notes,photo_data,origin_unit,cause,investigation_status,action_taken,created_at,created_by,client_uid FROM load_occurrences WHERE load_id=$1 ORDER BY id ASC`,[l.id]);
    const occurrenceSummary=occurrences.rows.reduce((a,o)=>{const t=String(o.type||'OUTRO').toUpperCase();a.total++;a[t]=(a[t]||0)+1;if(o.photo_data)a.photos++;return a},{total:0,SOBRA:0,AVARIA:0,INVERSAO:0,VENCIDO:0,OUTRO:0,photos:0});
    res.json({load:l,items:items.rows,faults,occurrences:occurrences.rows,occurrence_count:occurrences.rows.length,occurrence_summary:occurrenceSummary});
  }catch(e){
    console.error(e);
    res.status(500).json({error:"Erro interno do servidor"});
  }
});

app.get("/api/loads/:id/full-report.csv",auth,async(req,res)=>{
  try{
    const lr=await dbQuery(`SELECT l.*,u.name AS conferer_name FROM loads l LEFT JOIN users u ON u.id=l.conferer_id WHERE l.id=$1`,[req.params.id]);
    const l=lr.rows[0];
    if(!l)return res.status(404).send("Carga não encontrada");
    const ir=await dbQuery(`SELECT sku,product,lot,boxes,fraction,gross_weight,shortage_boxes,shortage_units,checked,checked_at,checked_by FROM items WHERE load_id=$1 ORDER BY id ASC`,[l.id]);
    const esc=v=>`"${String(v??"").replace(/"/g,'""')}"`;
    const rows=[
      ["RELATÓRIO COMPLETO DO PICKING"],
      ["Transporte",l.transport],
      ["Cliente",l.client],
      ["Placa do truck/cavalo que vai carregar",l.truck_plate||""],
      ["Placa da carreta / alocação para conferência",l.plate||l.trailer_plate||""],
      ["Conferente",l.conferer_name||""],
      ["Status",l.status],
      ["Início",l.started_at||""],
      ["Finalização",l.finished_at||""],
      ["Pallets seco",Number(l.pallet_seco||0)],
      ["Pallets refrigerado",Number(l.pallet_refri||0)],
      ["Pallets total",Number(l.pallet_total||0)],
      ["Peso bruto total",ir.rows.reduce((a,i)=>a+Number(i.gross_weight||0),0)],
      [],
      ["OCORRÊNCIAS"],
      ["Tipo","SKU","Lote","CX","UN","Observação","Foto","Unidade de origem","Causa","Investigação","Ação tomada"],
      ["SKU","Produto","Lote","CX","Fração","Peso bruto","Falta CX","Falta UN","Status","Conferido em","Conferido por"]
    ];
    const or=await dbQuery(`SELECT type,sku,lot,boxes,units,notes,photo_data,origin_unit,cause,investigation_status,action_taken FROM load_occurrences WHERE load_id=$1 ORDER BY id ASC`,[l.id]);
    for(const o of or.rows){
      rows.push([o.type,o.sku,o.lot||"",o.boxes||0,o.units||0,o.notes||"",o.photo_data?"SIM":"NÃO",o.origin_unit||"",o.cause||"",o.investigation_status||"EM_ANALISE",o.action_taken||""]);
    }
    rows.push([]);
    rows.push(["ITENS DO PICKING"]);
    rows.push(["SKU","Produto","Lote","CX","Fração","Peso bruto","Falta CX","Falta UN","Status","Conferido em","Conferido por"]);
    for(const i of ir.rows){
      rows.push([i.sku,i.product,i.lot||"",i.boxes||0,i.fraction||0,i.gross_weight||0,i.shortage_boxes||0,i.shortage_units||0,(Number(i.shortage_boxes||0)>0||Number(i.shortage_units||0)>0)?"FALTA":"OK",i.checked_at||"",i.checked_by||""]);
    }
    const csv="\uFEFF"+rows.map(r=>r.map(esc).join(";")).join("\r\n");
    const name=`picking-completo-${String(l.transport||l.id).replace(/[^a-z0-9_-]/gi,"_")}.csv`;
    res.setHeader("Content-Type","text/csv; charset=utf-8");
    res.setHeader("Content-Disposition",`attachment; filename="${name}"`);
    res.send(csv);
  }catch(e){console.error("full-report.csv",e);res.status(500).send("Erro ao gerar relatório completo");}
});

// Indicadores mensais calculados a partir dos registros operacionais reais.
app.get("/api/management/monthly",auth,roles("ADMIN","CARGAS"),async(req,res)=>{
  try{
    const month=String(req.query.month||"");
    if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(month))return res.status(400).json({error:"Informe o mês no formato AAAA-MM"});
    const start=`${month}-01`;
    const endR=await dbQuery("SELECT to_char(($1::date + INTERVAL '1 month')::date, 'YYYY-MM-DD') AS end_date, to_char(($1::date - INTERVAL '1 month')::date, 'YYYY-MM-DD') AS prev_date",[start]);
    const end=endR.rows[0].end_date,prevMonth=endR.rows[0].prev_date.slice(0,7);
    async function collect(periodStart,periodEnd){
      const loadsR=await dbQuery(`SELECT l.id,l.transport,l.client,l.status,l.created_at,l.started_at,l.finished_at,l.conferer_id,u.name AS conferer_name,u.job_title
        FROM loads l LEFT JOIN users u ON u.id=l.conferer_id
        WHERE (l.created_at >= ($1::date::timestamp AT TIME ZONE 'America/Sao_Paulo') AND l.created_at < ($2::date::timestamp AT TIME ZONE 'America/Sao_Paulo'))
           OR (l.finished_at >= ($1::date::timestamp AT TIME ZONE 'America/Sao_Paulo') AND l.finished_at < ($2::date::timestamp AT TIME ZONE 'America/Sao_Paulo'))
           OR (l.started_at >= ($1::date::timestamp AT TIME ZONE 'America/Sao_Paulo') AND l.started_at < ($2::date::timestamp AT TIME ZONE 'America/Sao_Paulo'))
        ORDER BY l.id`,[periodStart,periodEnd]);
      const loads=loadsR.rows;
      const inPeriod=(v)=>{if(!v)return false;const t=new Date(v).getTime();return Number.isFinite(t)&&t>=new Date(periodStart+"T03:00:00Z").getTime()&&t<new Date(periodEnd+"T03:00:00Z").getTime()};
      const receivedLoads=loads.filter(l=>inPeriod(l.created_at));
      const completedLoads=loads.filter(l=>String(l.status||"").toUpperCase()==="CONCLUIDA"&&inPeriod(l.finished_at));
      const completedIds=completedLoads.map(x=>Number(x.id));
      const ids=loads.map(x=>Number(x.id));
      let items=[],occ=[];
      if(ids.length){
        const ir=await dbQuery(`SELECT i.id,i.load_id,i.sku,i.product,i.lot,i.gross_weight,i.shortage_boxes,i.shortage_units,i.checked_at FROM items i WHERE i.load_id=ANY($1::bigint[])`,[ids]);items=ir.rows;
      }
      const or=await dbQuery(`SELECT o.id,o.load_id,o.type,o.sku,o.lot,o.boxes,o.units,o.notes,o.origin_unit,o.cause,o.investigation_status,o.action_taken,o.created_at,l.transport,l.client FROM load_occurrences o JOIN loads l ON l.id=o.load_id WHERE o.created_at >= ($1::date::timestamp AT TIME ZONE 'America/Sao_Paulo') AND o.created_at < ($2::date::timestamp AT TIME ZONE 'America/Sao_Paulo')`,[periodStart,periodEnd]);occ=or.rows;
      const byTransport=new Map();for(const l of loads){const k=String(l.transport||`load-${l.id}`).trim().toUpperCase();if(!byTransport.has(k))byTransport.set(k,[]);byTransport.get(k).push(l)}
      const finalizedR=await dbQuery(`SELECT COUNT(DISTINCT UPPER(BTRIM(l.transport)))::int AS count
        FROM loads l WHERE l.finished_at >= ($1::date::timestamp AT TIME ZONE 'America/Sao_Paulo') AND l.finished_at < ($2::date::timestamp AT TIME ZONE 'America/Sao_Paulo')
          AND COALESCE(BTRIM(l.transport),'')<>''
          AND NOT EXISTS (SELECT 1 FROM loads other WHERE UPPER(BTRIM(other.transport))=UPPER(BTRIM(l.transport)) AND UPPER(COALESCE(other.status,''))<>'CONCLUIDA')`,[periodStart,periodEnd]);
      const finalizedTransportCount=Number(finalizedR.rows[0]?.count||0);
      const duration=completedLoads.map(l=>{if(!l.started_at||!l.finished_at)return null;const n=(new Date(l.finished_at)-new Date(l.started_at))/60000;return Number.isFinite(n)&&n>=0?n:null}).filter(v=>v!==null);
      const shortageItems=items.filter(i=>(Number(i.shortage_boxes||0)>0||Number(i.shortage_units||0)>0)&&(inPeriod(i.checked_at)||inPeriod(loads.find(l=>Number(l.id)===Number(i.load_id))?.created_at)));
      const movedItems=items.filter(i=>completedIds.includes(Number(i.load_id)));
      const receivedTransportKeys=new Set(receivedLoads.map(l=>String(l.transport||`load-${l.id}`).trim().toUpperCase()));
      const affected=new Set([...occ.map(o=>String(o.transport||"").trim().toUpperCase()),...shortageItems.map(i=>String(loads.find(l=>Number(l.id)===Number(i.load_id))?.transport||"").trim().toUpperCase())].filter(k=>k&&receivedTransportKeys.has(k)));
      const categories={FALTA:shortageItems.length};
      for(const o of occ){let t=String(o.type||"OUTRO").toUpperCase();if(t.includes("INVERS"))t="INVERSAO";else if(t.includes("FALTA"))t="FALTA";else if(t.includes("SOBRA"))t="SOBRA";else if(t.includes("AVARIA"))t="AVARIA";else if(t.includes("VENC"))t="VENCIDO";else if(t.includes("LOTE"))t="LOTE";else if(t.includes("QUANT"))t="QUANTIDADE";else t="OUTRO";categories[t]=(categories[t]||0)+1;}
      const uniqueTransports=new Set(receivedLoads.map(l=>String(l.transport||`load-${l.id}`).trim().toUpperCase())).size;
      return {month:periodStart.slice(0,7),vehicles_received:uniqueTransports,vehicles_loaded:null,loaded_metric_note:"O sistema atual não registra uma etapa específica de carregamento/saída; esse indicador não pode ser calculado com segurança.",finalized_transports:finalizedTransportCount,loads_conferred:completedLoads.length,tonnes_moved:movedItems.reduce((a,i)=>a+Number(i.gross_weight||0),0)/1000,gross_weight_kg:movedItems.reduce((a,i)=>a+Number(i.gross_weight||0),0),occurrence_loads:affected.size,loads_without_occurrence:Math.max(0,uniqueTransports-affected.size),occurrence_count:occ.length+shortageItems.length,occurrence_categories:categories,occurrence_rate_pct:uniqueTransports?Math.round(affected.size/uniqueTransports*10000)/100:0,average_conference_minutes:duration.length?Math.round(duration.reduce((a,b)=>a+b,0)/duration.length*10)/10:null,min_conference_minutes:duration.length?Math.round(Math.min(...duration)*10)/10:null,max_conference_minutes:duration.length?Math.round(Math.max(...duration)*10)/10:null,timed_conferences:duration.length,transports:loads,occurrences:[...occ.map(o=>({...o,created_at:o.created_at})),...shortageItems.map(i=>{const l=loads.find(x=>Number(x.id)===Number(i.load_id));return {id:`falta-${i.id}`,load_id:i.load_id,type:"FALTA",sku:i.sku,product:i.product,lot:i.lot,boxes:Number(i.shortage_boxes||0),units:Number(i.shortage_units||0),notes:"Falta registrada nos campos de divergência",created_at:l?.finished_at||l?.created_at,transport:l?.transport||"",client:l?.client||""};})],people:completedLoads.reduce((acc,l)=>{if(!l.conferer_id)return acc;const k=String(l.conferer_id);if(!acc[k])acc[k]={user_id:Number(l.conferer_id),name:l.conferer_name||"Usuário",job_title:l.job_title||"",completed_loads:0,total_minutes:0,timed_loads:0};acc[k].completed_loads++;if(l.started_at&&l.finished_at){const n=(new Date(l.finished_at)-new Date(l.started_at))/60000;if(Number.isFinite(n)&&n>=0){acc[k].total_minutes+=n;acc[k].timed_loads++;}}return acc;}, {})};
    }
    const metrics=await collect(start,end);const previous=await collect(`${prevMonth}-01`,start);
    const hist=await dbQuery(`SELECT h.id,h.report_month,h.highlight_user_id,h.highlight_name,h.highlight_reason,h.metrics,h.criteria,h.created_at,u.name AS closed_by_name FROM monthly_report_history h LEFT JOIN users u ON u.id=h.closed_by WHERE h.report_month=$1::date ORDER BY h.created_at DESC LIMIT 10`,[start]);
    const users=await dbQuery(`SELECT id,name,job_title,role FROM users WHERE active=1 ORDER BY name`);
    const candidates=Object.values(metrics.people).map(p=>({...p,average_minutes:p.timed_loads?p.total_minutes/p.timed_loads:null})).sort((a,b)=>String(a.name).localeCompare(String(b.name),"pt-BR"));
    res.json({metrics,previous,history:hist.rows,candidates,users:users.rows.map(u=>({id:Number(u.id),name:u.name,job_title:u.job_title||"",role:u.role}))});
  }catch(e){console.error("management monthly",e);res.status(500).json({error:"Não foi possível calcular os indicadores mensais"});}
});
app.get("/api/management/history",auth,roles("ADMIN","CARGAS"),async(req,res)=>{
  try{const r=await dbQuery(`SELECT h.id,h.report_month,h.metrics,h.highlight_user_id,h.highlight_name,h.highlight_reason,h.criteria,h.created_at,u.name AS closed_by_name FROM monthly_report_history h LEFT JOIN users u ON u.id=h.closed_by ORDER BY h.report_month DESC,h.created_at DESC LIMIT 120`);res.json(r.rows);}
  catch(e){console.error(e);res.status(500).json({error:"Não foi possível carregar o histórico mensal"});}
});
app.post("/api/management/close",auth,roles("ADMIN"),async(req,res)=>{
  try{
    const month=String(req.body?.month||"");const highlightId=req.body?.highlight_user_id?Number(req.body.highlight_user_id):null;const reason=String(req.body?.reason||"").trim();const metrics=req.body?.metrics;
    if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)||!metrics||typeof metrics!=="object")return res.status(400).json({error:"Mês e indicadores calculados são obrigatórios"});
    let highlightName="";if(highlightId){const u=await dbQuery("SELECT name FROM users WHERE id=$1 AND active=1",[highlightId]);if(!u.rowCount)return res.status(400).json({error:"Colaborador selecionado não encontrado"});highlightName=u.rows[0].name;}
    const metricKeys=["month","vehicles_received","vehicles_loaded","loaded_metric_note","finalized_transports","loads_conferred","tonnes_moved","gross_weight_kg","occurrence_loads","loads_without_occurrence","occurrence_count","occurrence_categories","occurrence_rate_pct","average_conference_minutes","min_conference_minutes","max_conference_minutes","timed_conferences","people","previous"];
    const snapshot={};for(const key of metricKeys){if(!Object.prototype.hasOwnProperty.call(metrics,key))continue;if(key==="previous"&&metrics.previous&&typeof metrics.previous==="object"){snapshot.previous={};for(const summaryKey of metricKeys.filter(k=>!['previous','people'].includes(k)))if(Object.prototype.hasOwnProperty.call(metrics.previous,summaryKey))snapshot.previous[summaryKey]=metrics.previous[summaryKey];}else snapshot[key]=metrics[key];}
    const r=await dbQuery(`INSERT INTO monthly_report_history(report_month,metrics,highlight_user_id,highlight_name,highlight_reason,criteria,closed_by) VALUES($1::date,$2::jsonb,$3,$4,$5,$6::jsonb,$7) RETURNING id,report_month,created_at`,[`${month}-01`,JSON.stringify(snapshot),highlightId,highlightName,reason,JSON.stringify({selection:"confirmação manual do responsável",ranking_limit:"Não há dados suficientes para um ranking justo entre funções diferentes."}),req.user.id]);
    await dbQuery("INSERT INTO audit(user_id,action,load_id,at) VALUES($1,$2,NULL,NOW())",[req.user.id,`FECHAMENTO_MENSAL_${month}`]);res.json({ok:true,record:r.rows[0]});
  }catch(e){console.error("management close",e);res.status(500).json({error:"Não foi possível salvar o fechamento mensal"});}
});

app.get("/health",(req,res)=>res.status(200).json({
  ok:true,service:"conferencia-picking",time:new Date().toISOString()
}));

app.use("/api",(req,res)=>{
  res.status(404).json({
    error:"API endpoint not found",
    path:req.path,
    method:req.method
  });
});

app.get("*",(req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));

app.use((err,req,res,next)=>{
  console.error(err);
  res.status(500).json({error:"Erro interno do servidor"});
});

initDb()
  .then(()=>app.listen(PORT,HOST,()=>console.log(`Sistema em http://${HOST}:${PORT}`)))
  .catch(err=>{
    console.error("Falha ao inicializar o banco:",err);
    process.exit(1);
  });
