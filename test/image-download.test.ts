import { afterEach, expect, spyOn, test } from "bun:test";
import { linkSync, existsSync, mkdtempSync, mkdirSync, readFileSync, renameSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import * as fsPromises from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ChatService } from "../src/core/chats";
import { MizitoClient } from "../src/core/client";
import { downloadImage, downloadVoice, fetchImageMedia } from "../src/core/download";
import { inspectImage, dimensions } from "../src/core/image";
import { MAX_IMAGE_BYTES } from "../src/core/limits";
import { parseHistory } from "../src/core/models";

const id = "0123456789abcdef01234567", secret = "synthetic-secret-token";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4ZkAAAAASUVORK5CYII=", "base64");
const roots: string[] = [];
function home() { const p = mkdtempSync(join(tmpdir(), "mizito-image-")); roots.push(p); return p; }
afterEach(async () => { await Promise.all(roots.splice(0).map(p => rm(p,{recursive:true,force:true}))); });
function variant(extra: Record<string,unknown> = {}) { return { content: secret, content_key: "secret-key", w: 1, h: 1, size: png.length, ...extra }; }
function message(extra: Record<string,unknown> = {}) { return { _id: id, _: "message", from: "u", date: 1, msg_index: 1, media: { _: "messageMediaPhoto", photo: { _id: "photo", name: "../../malicious.svg", photo_large: variant() } }, ...extra }; }
function fixture(o: { messages?: unknown[]; wrapped?: boolean; fixed?: unknown[]; bytes?: Buffer; mime?: string; headers?: Record<string,string>; fetcher?: (url: string, init?: RequestInit) => Promise<Response>; timeout?: number } = {}) {
  const requests: {url:string;init?:RequestInit}[] = [], history: number[] = [];
  const client = new MizitoClient({ credentials: { username: "", password: "" }, token: "session-secret", mediaTimeoutMs: o.timeout,
    fetch: (async (url: any, init?: RequestInit) => {
      requests.push({url:String(url),init});
      if (o.fetcher) return o.fetcher(String(url),init);
      return new Response(new Uint8Array(o.bytes ?? png), { headers: { "content-type": o.mime ?? "image/png", ...o.headers } });
    }) as typeof fetch });
  const chats = new ChatService({ post: async (path, body: any) => {
    if (path.endsWith("getDialogs")) return {dialogs:[{_id:"chat",title:"Exact Team",is_group:true}]};
    if (path.endsWith("getHistory")) { history.push(body.offset); const page = o.fixed ?? (o.messages ?? [message()]).slice(body.offset,body.offset+15); return o.wrapped ? {messages:page} : page; }
    throw new Error("unexpected call");
  }});
  return {client,chats,requests,history};
}
async function fetchMedia(f: ReturnType<typeof fixture>, allowed = true, messageId = id, chat = "Exact Team") { return fetchImageMedia(f.chats,f.client,chat,messageId,allowed); }

test("image gate and strict lowercase ID reject before all requests", async () => {
  const f = fixture();
  await expect(fetchMedia(f,false)).rejects.toThrow("disabled");
  for (const bad of [id.toUpperCase(), "../"+id, id+"\n", "", "https://evil.example/"]) await expect(fetchMedia(f,true,bad)).rejects.toThrow("lowercase");
  expect(f.history).toEqual([]); expect(f.requests).toEqual([]);
});
test("image exact chat rejects partial name and returns validated local bytes without keys", async () => {
  const f = fixture({wrapped:true});
  await expect(fetchMedia(f,true,id,"Team")).rejects.toThrow("No chat");
  const result = await fetchMedia(f);
  expect(result.data).toEqual(png); expect(result.width).toBe(1); expect(result.extension).toBe("png");
  expect(JSON.stringify({...result,data:undefined})).not.toContain(secret);
  expect(JSON.stringify(result)).not.toContain("secret-key");
  expect(f.requests[0]!.url).toBe(`https://app.mizito.ir/cdn/${secret}`);
  expect(f.requests[0]!.init?.redirect).toBe("error"); expect((f.requests[0]!.init?.headers as any)["x-token"]).toBe("session-secret");
});
test("read history remains metadata-only and does not expose variant credentials", () => {
  const out = parseHistory([message()],{id:"chat",name:"Exact Team",isGroup:true});
  expect(JSON.stringify(out)).not.toContain(secret); expect(JSON.stringify(out)).not.toContain("content_key");
  expect(out[0]!.attachment?.kind).toBe("photo");
});
test("fixed largest bounded variant preference skips invalid dimensions and sizes", async () => {
  for (const bad of [{w:Infinity},{h:NaN},{w:0},{w:1.2},{w:100000},{w:10000,h:10000},{size:MAX_IMAGE_BYTES+1},{size:-1},{size:"10"},{content:"https://evil.example/secret"}]) {
    const photo = {_id:"p",name:"ignored",photo_large:variant(bad),photo_medium:variant({content:"medium"}),photo_small:variant({content:"small"})};
    const f=fixture({messages:[message({media:{_:"messageMediaPhoto",photo}})]});
    expect((await fetchMedia(f)).variant).toBe("photo_medium"); expect(f.requests[0]!.url).toEndWith("/cdn/medium");
  }
});
test("missing schema and unsupported media are rejected without CDN requests", async () => {
  for (const media of [null,{_:"messageMediaDocument",document:{content:secret}},{_:"messageMediaPhoto",photo:{photo_large:variant()}},{_:"messageMediaPhoto",photo:{_id:"p",name:"a",photo_large:variant({w:"1"})}}]) {
    const f=fixture({messages:[message({media})]}); await expect(fetchMedia(f)).rejects.toThrow(); expect(f.requests).toEqual([]);
  }
});
test("deleted service and mismatched chat messages are ineligible", async () => {
  for (const extra of [{deleted:true},{is_deleted:true},{service:true},{_:"messageService"},{dialog:"other"},{dialog:{_id:"other"}},{chat_id:"other"},{chatId:"other"}]) {
    const f=fixture({messages:[message(extra)]}); await expect(fetchMedia(f)).rejects.toThrow(); expect(f.requests).toEqual([]);
  }
});
test("oversized wrapped or bare upstream pages cannot bypass history bound", async () => {
  for (const wrapped of [true,false]) {
    const f = fixture({wrapped,fixed:[...Array.from({length:200},(_,i)=>message({_id:String(i)})),message()]});
    await expect(fetchMedia(f)).rejects.toThrow(); expect(f.requests).toEqual([]);
    expect(f.history).toEqual(Array.from({length:13},(_,i)=>i*15));
  }
});
test("image MIME and signatures must agree; lengths and metadata dimensions must match", async () => {
  for (const o of [{mime:"image/svg+xml"},{mime:"text/html"},{mime:"image/jpeg"},{bytes:Buffer.from("not-an-image")},{bytes:png.subarray(0,-1)},{headers:{"content-length":String(png.length+1)}},{headers:{"content-length":"NaN"}},{headers:{"content-length":String(MAX_IMAGE_BYTES+1)}}]) {
    const f=fixture(o); await expect(fetchMedia(f)).rejects.toThrow();
  }
  const f=fixture({messages:[message({media:{_:"messageMediaPhoto",photo:{_id:"p",name:"a",photo_large:variant({w:2})}}})]});
  await expect(fetchMedia(f)).rejects.toThrow("dimensions");
});
test("image raw header bounds reject dimension bombs", () => {
  const bomb=Buffer.from(png); bomb.writeUInt32BE(100000,16);
  expect(()=>inspectImage(bomb,"image/png")).toThrow("dimensions");
  for (const d of [[Infinity,1],[NaN,1],[0,1],[1,-1],[10000,10000]]) expect(()=>dimensions(d[0],d[1])).toThrow();
});
test("non-overwriting image saves are private and independent of upstream filenames", async () => {
  const f=fixture(), h=home();
  if (process.platform !== "linux") {
    await expect(downloadImage(f.chats,f.client,"chat",id,h,true)).rejects.toThrow("Secure media downloads require Linux procfs");
    expect(existsSync(join(h,"downloads"))).toBe(false);
    return;
  }
  const result=await downloadImage(f.chats,f.client,"chat",id,h,true);
  expect(result.path).toBe(join(h,"downloads",`${id}.png`)); expect(readFileSync(result.path)).toEqual(png);
  expect(statSync(result.path).mode&0o777).toBe(0o600); expect(statSync(join(h,"downloads")).mode&0o777).toBe(0o700);
  expect(JSON.stringify(result)).not.toContain(secret); expect(JSON.stringify(result)).not.toContain("secret-key");
  await expect(downloadImage(f.chats,f.client,"chat",id,h,true)).rejects.toThrow("already exists"); expect(readFileSync(result.path)).toEqual(png);
});
test("symlink directory and destination never mutate targets", async () => {
  for (const directory of [true,false]) {
    const h=home(), target=home(), f=fixture();
    if (directory) symlinkSync(target,join(h,"downloads"));
    else { mkdirSync(join(h,"downloads")); writeFileSync(join(target,"keep"),"untouched"); symlinkSync(join(target,"keep"),join(h,"downloads",`${id}.png`)); }
    const before=statSync(target).mode;
    await expect(downloadImage(f.chats,f.client,"chat",id,h,true)).rejects.toThrow();
    expect(statSync(target).mode).toBe(before);
    if (!directory) expect(readFileSync(join(target,"keep"),"utf8")).toBe("untouched");
    expect(existsSync(join(target,`${id}.png`))).toBe(false);
  }
});
test("hanging fetch times out and aborts without leaking signed tokens", async () => {
  let signal: AbortSignal | undefined;
  const f=fixture({timeout:10,fetcher:async (_url,init)=>{signal=init?.signal as AbortSignal; return await new Promise(()=>{});}});
  const e=await fetchMedia(f).catch(e=>e); expect(e.message).not.toContain(secret); expect(e.message).not.toContain("session-secret"); expect(signal?.aborted).toBe(true);
});
test("hanging, oversized and aborted body streams are cancelled safely", async () => {
  for (const kind of ["hang","oversize","abort"]) {
    let cancelled=false;
    const body=new ReadableStream<Uint8Array>({start(c){if(kind==="oversize") c.enqueue(new Uint8Array(MAX_IMAGE_BYTES+1)); if(kind==="abort") c.error(new Error(secret));},cancel(){cancelled=true;}});
    const f=fixture({timeout:10,fetcher:async()=>new Response(body,{headers:{"content-type":"image/png"}})});
    const e=await fetchMedia(f).catch(e=>e); expect(e.message).not.toContain(secret); if(kind!=="abort") expect(cancelled).toBe(true);
  }
});
test("invalid content paths are rejected before fetch, errors never echo input", async () => {
  for(const content of ["..",".","../x","a/b","%2fsecret","https://evil.example","a?token=secret","a\\b","a\n","a".repeat(2049)]) {
    const f=fixture(); const e=await f.client.downloadImage(content).catch(e=>e); expect(e.message).toContain("invalid media token"); expect(f.requests).toEqual([]);
  }
});
test("image request redirect and upstream exceptions are private", async () => {
  for (const fetcher of [async()=>new Response(secret,{status:302,headers:{location:"https://evil.example"}}),async()=>{throw new Error(secret+"session-secret");}]) {
    const f=fixture({fetcher}); const e=await fetchMedia(f).catch(e=>e); expect(e.message).not.toContain(secret); expect(e.message).not.toContain("session-secret");
  }
});

test("JPEG and WebP binary formats validate and download with safe extensions", async () => {
  const jpeg=Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD5/ooooA//2Q==","base64");
  const webp=Buffer.from("UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAUAmJaQAA3AA/v02aAA=","base64");
  for(const [bytes,mime,extension] of [[jpeg,"image/jpeg","jpg"],[webp,"image/webp","webp"]] as const) {
    expect(inspectImage(bytes,mime)).toEqual({width:1,height:1,extension});
    const f=fixture({bytes,mime,messages:[message({media:{_:"messageMediaPhoto",photo:{_id:"p",name:"evil",photo_large:variant({size:bytes.length})}}})]});
    if (process.platform === "linux") {
      const result=await downloadImage(f.chats,f.client,"chat",id,home(),true);
      expect(result.path).toEndWith(`.${extension}`); expect(readFileSync(result.path)).toEqual(bytes);
    } else {
      const media = await fetchMedia(f);
      expect(media.data).toEqual(bytes); expect(media.extension).toBe(extension);
    }
    expect(()=>inspectImage(bytes.subarray(0,-1),mime)).toThrow();
  }
});
test("voice strict IDs and shared bounded wrapped history protections remain active", async () => {
  for (const wrapped of [true,false]) {
    const f=fixture({wrapped,fixed:[...Array.from({length:200},(_,i)=>message({_id:String(i)})),{_id:id,_:"message",media:{_:"messageMediaAudio",audio:{content:secret,is_voice:true,duration:1}}}]});
    await expect(f.chats.fetchVoiceAudio("chat",id,f.client)).rejects.toThrow();
    expect(f.requests).toEqual([]); expect(f.history).toHaveLength(13);
  }
  const f=fixture();
  await expect(downloadVoice(f.chats,f.client,"chat",id.toUpperCase(),home(),true)).rejects.toThrow("lowercase"); expect(f.requests).toEqual([]); expect(f.history).toEqual([]);
});
test("home symlinks and destination hardlinks are refused without changing existing targets", async () => {
  const target=home(), h=home(), f=fixture(); symlinkSync(target,join(h,"linked"));
  await expect(downloadImage(f.chats,f.client,"chat",id,join(h,"linked"),true)).rejects.toThrow();
  expect(existsSync(join(target,"downloads"))).toBe(false);
  mkdirSync(join(h,"downloads")); writeFileSync(join(target,"keep"),"unchanged");
  linkSync(join(target,"keep"),join(h,"downloads",`${id}.png`));
  await expect(downloadImage(f.chats,f.client,"chat",id,h,true)).rejects.toThrow();
  expect(readFileSync(join(target,"keep"),"utf8")).toBe("unchanged");
});

test("directory swap after descriptor open cannot redirect chmod or write to symlink target", async () => {
  if (process.platform !== "linux") return;
  const h=home(), target=home(), f=fixture();
  const before=statSync(target).mode, originalOpen=fsPromises.open;
  let swapped=false;
  const hook=spyOn(fsPromises,"open").mockImplementation((async (...args: Parameters<typeof fsPromises.open>) => {
    const handle=await originalOpen(...args);
    if (!swapped && String(args[0]).match(/^\/proc\/self\/fd\/\d+\/downloads$/)) {
      swapped=true;
      renameSync(join(h,"downloads"),join(h,"moved")); symlinkSync(target,join(h,"downloads"));
    }
    return handle;
  }) as typeof fsPromises.open);
  try { await expect(downloadImage(f.chats,f.client,"chat",id,h,true)).rejects.toThrow("unsafe"); }
  finally {hook.mockRestore();}
  expect(swapped).toBe(true); expect(statSync(target).mode).toBe(before);
  expect(existsSync(join(target,`${id}.png`))).toBe(false);
  expect(existsSync(join(h,"moved",`${id}.png`))).toBe(false);
});
