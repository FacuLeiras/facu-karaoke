(() => {
  const cfg = window.KARAOKE_CONFIG || {};
  const apiKey = cfg.supabasePublishableKey || cfg.supabaseAnonKey || "";
  const configured = Boolean(cfg.supabaseUrl && apiKey && window.supabase);
  let db = null;
  let session = null;
  let isHost = false;
  let remoteQueue = [];
  let pendingSong = null;
  let customMode = false;

  const $ = (s) => document.querySelector(s);
  const safe = (s) => String(s ?? "").replace(/[&<>"']/g, m => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"
  }[m]));

  const css = document.createElement("style");
  css.textContent = `
    .rt-banner{max-width:1240px;margin:12px auto 0;padding:10px 14px;border-radius:12px;background:#ffffff0b;border:1px solid var(--line);font-size:12px;color:var(--muted)}
    .rt-banner.ok{color:#bfffe9;border-color:#285d50;background:#123027}
    .rt-now{max-width:1240px;margin:12px auto 0;padding:14px 16px;border-radius:16px;border:1px solid var(--line);background:linear-gradient(135deg,#2a1835,#151119)}
    .rt-now b{color:var(--accent)}
    .rt-modal{position:fixed;inset:0;background:#000a;z-index:99;display:none;place-items:center;padding:20px}
    .rt-modal.open{display:grid}
    .rt-dialog{width:min(520px,100%);background:#17131d;border:1px solid var(--line);border-radius:20px;padding:20px;box-shadow:0 30px 100px #000}
    .rt-dialog h3{margin:0 0 12px;font-size:22px}
    .rt-dialog label{display:block;color:var(--muted);font-size:12px;margin:10px 0 5px}
    .rt-dialog input{width:100%}
    .rt-dialog .row{display:flex;gap:8px;margin-top:16px}
    .rt-dialog .row button{flex:1}
    .rt-song{padding:11px 14px;border-bottom:1px solid var(--line)}
    .rt-song:last-child{border-bottom:0}
    .rt-host-actions{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
    .rt-host-actions button{font-size:11px;padding:7px 9px}
    .rt-pos{display:inline-grid;place-items:center;min-width:32px;height:32px;border-radius:9px;background:#ffffff0c;color:var(--accent);font-weight:900;margin-right:8px}
    @media(min-width:900px){.searchrow{grid-template-columns:minmax(240px,1fr) repeat(5,auto)!important}}
  `;
  document.head.appendChild(css);

  const modal = document.createElement("div");
  modal.className = "rt-modal";
  modal.id = "requestModal";
  modal.innerHTML = `
    <div class="rt-dialog">
      <h3>🎤 Pedir canción</h3>
      <div id="rtSongSummary"></div>
      <label>¿Quién sos?</label>
      <input id="rtSinger" maxlength="80" placeholder="Tu nombre">
      <div id="rtCustomFields" style="display:none">
        <label>Canción</label>
        <input id="rtCustomTitle" maxlength="160" placeholder="Ej: En la ciudad de la furia">
        <label>Artista <span style="opacity:.65">(opcional)</span></label>
        <input id="rtCustomArtist" maxlength="120" placeholder="Ej: Soda Stereo">
      </div>
      <div class="row">
        <button class="secondary" id="rtCancel">Cancelar</button>
        <button id="rtSubmit">Agregar a la cola</button>
      </div>
    </div>`;
  document.body.appendChild(modal);

  function ytSearch(title, artist="") {
    const q = [artist, title, "karaoke letra sincronizada colores"].filter(Boolean).join(" ");
    return "https://www.youtube.com/results?search_query=" + encodeURIComponent(q);
  }

  async function openSingaSearch(title, artist="") {
    const q = [artist, title].filter(Boolean).join(" ");
    try { await navigator.clipboard.writeText(q); } catch {}
    window.open("https://singa.com/songs", "_blank");
  }

  function openRequest(song=null) {
    customMode = !song;
    pendingSong = song;
    $("#rtSinger").value = localStorage.getItem("karaokeSingerName") || "";
    $("#rtCustomFields").style.display = customMode ? "block" : "none";
    $("#rtCustomTitle").value = "";
    $("#rtCustomArtist").value = "";
    $("#rtSongSummary").innerHTML = customMode
      ? `<div class="rt-banner" style="margin:0">No está en el catálogo: escribila y genero automáticamente su búsqueda de karaoke en YouTube.</div>`
      : `<div class="rt-banner" style="margin:0"><b>${safe(song.title)}</b><br>${safe(song.artist)}</div>`;
    $("#requestModal").classList.add("open");
    setTimeout(() => $("#rtSinger").focus(), 50);
  }

  $("#rtCancel").onclick = () => $("#requestModal").classList.remove("open");

  $("#rtSubmit").onclick = async () => {
    const singer = $("#rtSinger").value.trim();
    if (!singer) return alert("Poné tu nombre 🙂");

    let title, artist, songId, source;
    if (customMode) {
      title = $("#rtCustomTitle").value.trim();
      artist = $("#rtCustomArtist").value.trim();
      if (!title) return alert("Poné el nombre de la canción.");
      songId = null; source = "custom";
    } else {
      title = pendingSong.title; artist = pendingSong.artist; songId = pendingSong.id; source = "catalog";
    }

    localStorage.setItem("karaokeSingerName", singer);

    if (!configured) {
      alert("La cola compartida todavía no está conectada a Supabase.");
      return;
    }

    const { error } = await db.from("karaoke_requests").insert({
      singer_name: singer,
      song_id: songId,
      title,
      artist,
      youtube_url: ytSearch(title, artist),
      source,
      status: "waiting"
    });

    if (error) {
      console.error(error);
      return alert("No pude agregar el pedido: " + error.message);
    }

    $("#requestModal").classList.remove("open");
    await refreshQueue();
    alert("🎉 ¡Agregada! Ya está en la cola compartida.");
  };

  function installButtons() {
    const toolbar = document.querySelector(".searchrow");
    if (toolbar && !document.getElementById("customSongBtn")) {
      const b = document.createElement("button");
      b.id = "customSongBtn"; b.className = "secondary";
      b.textContent = "➕ No está mi canción";
      b.onclick = () => openRequest(null);
      toolbar.appendChild(b);
    }
    if (toolbar && !document.getElementById("hostBtn")) {
      const b = document.createElement("button");
      b.id = "hostBtn"; b.className = "secondary";
      b.textContent = "🔐 Host";
      b.onclick = hostLogin;
      toolbar.appendChild(b);
    }

    // El botón "+ Cola" existente pasa a abrir el pedido con nombre.
    window.addQueue = (id) => {
      const s = songs.find(x => x.id === id);
      if (s) openRequest(s);
    };
  }

  function installStatus() {
    const hero = document.querySelector(".hero");
    if (!hero || document.getElementById("rtStatus")) return;

    const box = document.createElement("div");
    box.id = "rtStatus";
    box.className = "rt-banner " + (configured ? "ok" : "");
    box.innerHTML = configured
      ? "🟢 <b>Cola compartida activa.</b> Los pedidos se sincronizan entre celulares y la compu."
      : "🟡 <b>Cola compartida pendiente.</b> El catálogo normal sigue funcionando.";
    hero.after(box);

    const now = document.createElement("div");
    now.id = "rtNow"; now.className = "rt-now"; now.style.display = "none";
    box.after(now);
  }

  async function hostLogin() {
    if (!configured) return alert("Primero hay que conectar Supabase.");
    if (isHost) return alert("✅ Ya estás en modo Host.");

    const email = prompt("Email autorizado del Host:");
    if (!email) return;

    const { error } = await db.auth.signInWithOtp({
      email,
      options: {
        shouldCreateUser: true,
        emailRedirectTo: "https://faculeiras.github.io/facu-karaoke/"
      }
    });

    if (error) alert("No pude enviar el acceso: " + error.message);
    else alert("📩 Te mandé un Magic Link. Abrilo en esta misma compu.");
  }

  async function checkHost() {
    if (!configured) return;
    const { data: { session: s } } = await db.auth.getSession();
    session = s;
    if (!session) { isHost = false; return; }

    isHost = String(session?.user?.email || "").toLowerCase() === "faculeiras@hotmail.com";

    const hb = document.getElementById("hostBtn");
    if (hb) hb.textContent = isHost ? "🟢 Host" : "🔐 Host";
  }

  async function refreshQueue() {
    if (!configured) return;
    const { data, error } = await db.from("karaoke_requests")
      .select("*")
      .in("status", ["waiting", "current"])
      .order("sort_order", { ascending: true })
      .order("created_at", { ascending: true });

    if (error) {
      console.error(error);
      return;
    }

    remoteQueue = data || [];
    updateQueueUI();
  }

  function updateQueueUI() {
    if (!configured) return;

    const current = remoteQueue.find(r => r.status === "current");
    const waiting = remoteQueue.filter(r => r.status === "waiting");
    const now = $("#rtNow");

    if (now) {
      now.style.display = current ? "block" : "none";
      if (current) {
        now.innerHTML = `<b>🎤 Ahora canta:</b> ${safe(current.singer_name)} — ${safe(current.title)}
          <span style="color:var(--muted)">· ${safe(current.artist || "")}</span>`;
      }
    }

    const qc = document.getElementById("qcount");
    if (qc) qc.textContent = waiting.length + (current ? 1 : 0);

    const el = document.getElementById("queueList");
    if (!el) return;

    if (!current && !waiting.length) {
      el.innerHTML = `<div class="empty">La cola compartida está vacía.</div>`;
      return;
    }

    const rows = [];
    if (current) rows.push(renderRequest(current, "AHORA"));
    waiting.forEach((r, i) => rows.push(renderRequest(r, String(i + 1))));
    el.innerHTML = rows.join("");
  }

  function renderRequest(r, pos) {
    const badge = r.source === "custom" ? " · 🆕 fuera del catálogo" : "";
    const controls = isHost ? `
      <div class="rt-host-actions">
        <button class="yt" onclick="hostSinga(${r.id})">🎤 Singa · sync + voz guía</button>
        <button class="secondary" onclick="window.open('${r.youtube_url}','_blank')">▶ YouTube sync</button>
        ${r.status !== "current" ? `<button class="queue" onclick="hostCurrent(${r.id})">🎤 Ahora</button>` : ""}
        ${r.status === "waiting" ? `<button class="secondary" onclick="hostMove(${r.id},-1)">↑</button><button class="secondary" onclick="hostMove(${r.id},1)">↓</button>` : ""}
        <button class="secondary" onclick="hostDone(${r.id})">✅ Cantada</button>
        ${r.source === "custom" ? `<button class="secondary" onclick="hostSaveSong(${r.id})">➕ Catálogo</button>` : ""}
        <button class="secondary" onclick="hostDelete(${r.id})">🗑</button>
      </div>` : "";

    return `<div class="rt-song">
      <span class="rt-pos">${pos}</span><b>${safe(r.singer_name)}</b> — ${safe(r.title)}
      <span style="color:var(--muted)">· ${safe(r.artist || "")}${badge}</span>
      ${controls}
    </div>`;
  }

  window.hostSinga = async (id) => {
    const r = remoteQueue.find(x => x.id === id);
    if (!r) return;
    await openSingaSearch(r.title, r.artist || "");
  };

  window.hostCurrent = async (id) => {
    if (!isHost) return;
    const current = remoteQueue.find(r => r.status === "current");
    if (current && current.id !== id) {
      await db.from("karaoke_requests").update({ status: "waiting" }).eq("id", current.id);
    }
    await db.from("karaoke_requests").update({ status: "current" }).eq("id", id);
    await refreshQueue();
  };

  window.hostDone = async (id) => {
    if (!isHost) return;
    await db.from("karaoke_requests").update({ status: "done" }).eq("id", id);
    await refreshQueue();
  };

  window.hostDelete = async (id) => {
    if (!isHost || !confirm("¿Quitar este pedido?")) return;
    await db.from("karaoke_requests").delete().eq("id", id);
    await refreshQueue();
  };

  window.hostMove = async (id, dir) => {
    if (!isHost) return;
    const waiting = remoteQueue.filter(r => r.status === "waiting");
    const i = waiting.findIndex(r => r.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= waiting.length) return;

    const a = waiting[i], b = waiting[j];
    const aOrder = a.sort_order, bOrder = b.sort_order;
    await db.from("karaoke_requests").update({ sort_order: bOrder }).eq("id", a.id);
    await db.from("karaoke_requests").update({ sort_order: aOrder }).eq("id", b.id);
    await refreshQueue();
  };

  window.hostSaveSong = async (id) => {
    if (!isHost) return;
    const r = remoteQueue.find(x => x.id === id);
    if (!r) return;

    const { error } = await db.from("karaoke_custom_songs").insert({
      title: r.title,
      artist: r.artist || "",
      youtube_url: r.youtube_url,
      added_by: session?.user?.email || ""
    });

    if (error && !String(error.message).toLowerCase().includes("duplicate")) {
      alert(error.message);
    } else {
      alert("✅ Guardada para futuros karaokes.");
      await loadCustomSongs();
    }
  };

  async function loadCustomSongs() {
    if (!configured) return;
    const { data, error } = await db.from("karaoke_custom_songs")
      .select("*")
      .order("created_at", { ascending: true });

    if (error || !data) return;

    let nextId = Math.max(...songs.map(s => s.id), 0) + 1;
    data.forEach(x => {
      const exists = songs.some(s =>
        s.title.toLowerCase() === x.title.toLowerCase() &&
        s.artist.toLowerCase() === String(x.artist || "").toLowerCase()
      );

      if (!exists) {
        songs.push({
          id: nextId++,
          title: x.title,
          artist: x.artist || "",
          genre: "Agregadas por invitados",
          lang: "",
          difficulty: "",
          tags: ["🆕 Comunidad"],
          current: false
        });
      }
    });

    if (typeof render === "function") render();
  }


  async function init() {
    installButtons();
    installStatus();

    if (!configured) return;

    db = window.supabase.createClient(cfg.supabaseUrl, apiKey);
    await checkHost();
    await loadCustomSongs();
    await refreshQueue();

    db.channel("karaoke-live")
      .on("postgres_changes", { event: "*", schema: "public", table: "karaoke_requests" }, refreshQueue)
      .on("postgres_changes", { event: "*", schema: "public", table: "karaoke_custom_songs" }, loadCustomSongs)
      .subscribe();

    db.auth.onAuthStateChange(async (_event, s) => {
      session = s;
      await checkHost();
      updateQueueUI();
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
