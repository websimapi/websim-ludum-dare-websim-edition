import { jsxDEV } from "react/jsx-dev-runtime";
import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { WebsimSocket, useQuery } from "@websim/use-query";
const room = new WebsimSocket();
const DAY_MS = 24 * 60 * 60 * 1e3;
function todayId(date = /* @__PURE__ */ new Date()) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}
function msUntilTomorrowUTC() {
  const now = /* @__PURE__ */ new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0));
  return next - now;
}
function ts() {
  return (/* @__PURE__ */ new Date()).toISOString();
}
async function fetchCatalog() {
  const res = await fetch("categories_and_themes.json");
  return await res.json();
}
async function aiPickCategoryTheme(catalog) {
  try {
    const completion = await websim.chat.completions.create({
      messages: [
        {
          role: "system",
          content: "Respond ONLY with JSON. From the provided lists, output a novel combination that feels fresh for a daily game jam."
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `Choose one category and one theme. If a very similar combination has been seen recently, vary it. JSON schema:
{"category": string, "theme": string, "rationale": string}`
            },
            { type: "text", text: `Categories: ${catalog.categories.join(", ")}` },
            { type: "text", text: `Themes: ${catalog.themes.join(", ")}` }
          ]
        }
      ],
      json: true
    });
    const out = JSON.parse(completion.content);
    if (out?.category && out?.theme) return out;
  } catch (e) {
    console.warn("AI pick failed, falling back to random.", e);
  }
  const cat = catalog.categories[Math.floor(Math.random() * catalog.categories.length)];
  const th = catalog.themes[Math.floor(Math.random() * catalog.themes.length)];
  return { category: cat, theme: th, rationale: "fallback_random" };
}
async function ensureTodayEvent() {
  const id = todayId();
  const events = await room.collection("event").filter({ id }).getList();
  if (events && events.length > 0) return events[0];
  const catalog = await fetchCatalog();
  const picked = await aiPickCategoryTheme(catalog);
  const history = [{ ts: ts(), action: "create_event", by: (await window.websim.getCurrentUser()).id, data: picked }];
  try {
    const created = await room.collection("event").upsert({
      id,
      category: picked.category,
      theme: picked.theme,
      seed_meta: { rationale: picked.rationale || null, catalog_version: "embedded" },
      history
    });
    return created;
  } catch (e) {
    const retry = await room.collection("event").filter({ id }).getList();
    return retry[0];
  }
}
function useEvents() {
  const { data: events = [], loading } = useQuery(room.collection("event"));
  const sorted = useMemo(() => [...events].sort((a, b) => a.id < b.id ? 1 : -1), [events]);
  return { events: sorted, loading };
}
function useSelectedEvent(events) {
  const urlParams = new URLSearchParams(window.location.search);
  const initialId = urlParams.get("event") || todayId();
  const [selectedId, setSelectedId] = useState(initialId);
  const selected = useMemo(() => events.find((e) => e.id === selectedId) || events[0], [events, selectedId]);
  useEffect(() => {
    const base = window.baseUrl || window.location.origin + window.location.pathname;
    const params = new URLSearchParams(window.location.search);
    if (selected?.id) {
      params.set("event", selected.id);
      window.history.replaceState(null, "", `${base}?${params.toString()}`);
    }
  }, [selected?.id]);
  return { selected, selectedId, setSelectedId };
}
function useJamEntrySync() {
  const [currentUserId, setCurrentUserId] = useState(null);
  const { data: entryList = [] } = useQuery(
    useMemo(() => room.collection("jam_entry").filter({ id: currentUserId || "" }), [currentUserId])
  );
  useEffect(() => {
    (async () => {
      const u = await window.websim.getCurrentUser();
      setCurrentUserId(u.id);
      try {
        await room.collection("jam_entry").upsert({
          id: u.id,
          profile: { username: u.username, created_ts: ts() },
          submissions: {},
          history: [{ ts: ts(), action: "init_entry", by: u.id }]
        });
      } catch (e) {
      }
    })();
  }, []);
  const entry = entryList[0];
  useEffect(() => {
    if (!currentUserId) return;
    const key = `jam_entry_backup_${currentUserId}`;
    const local = localStorage.getItem(key);
    if (!local) {
      if (entry) {
        localStorage.setItem(key, JSON.stringify(entry));
      }
      return;
    }
    const localObj = JSON.parse(local);
    if (!entry) return;
    const merged = { ...entry };
    merged.submissions = { ...entry.submissions || {} };
    const localSubs = localObj.submissions || {};
    for (const [eventId, sub] of Object.entries(localSubs)) {
      const remote = merged.submissions[eventId];
      const remoteTs = remote?.updated_at ? Date.parse(remote.updated_at) : 0;
      const localTs = sub?.updated_at ? Date.parse(sub.updated_at) : 0;
      if (localTs > remoteTs) {
        merged.submissions[eventId] = sub;
      }
    }
    if (JSON.stringify(merged.submissions) !== JSON.stringify(entry.submissions || {})) {
      room.collection("jam_entry").upsert({
        id: entry.id,
        submissions: merged.submissions,
        history: [
          ...entry.history || [],
          { ts: ts(), action: "merge_from_local", by: entry.id }
        ],
        backup_ts: ts()
      }).then(() => {
        localStorage.setItem(key, JSON.stringify({ ...entry, submissions: merged.submissions }));
      });
    } else {
      localStorage.setItem(key, JSON.stringify(entry));
    }
  }, [entry?.id, JSON.stringify(entry?.submissions || {})]);
  const backupLocal = (updated) => {
    if (!currentUserId) return;
    const key = `jam_entry_backup_${currentUserId}`;
    localStorage.setItem(key, JSON.stringify(updated));
  };
  return { entry, currentUserId, backupLocal };
}
function Header({ currentEvent }) {
  const [remaining, setRemaining] = useState(msUntilTomorrowUTC());
  useEffect(() => {
    const i = setInterval(() => setRemaining(msUntilTomorrowUTC()), 1e3);
    return () => clearInterval(i);
  }, []);
  const hh = String(Math.floor(remaining / 36e5)).padStart(2, "0");
  const mm = String(Math.floor(remaining % 36e5 / 6e4)).padStart(2, "0");
  const ss = String(Math.floor(remaining % 6e4 / 1e3)).padStart(2, "0");
  return /* @__PURE__ */ jsxDEV("div", { className: "header", children: [
    /* @__PURE__ */ jsxDEV("div", { children: [
      /* @__PURE__ */ jsxDEV("div", { className: "h1", children: "Ludum Dare \u2014 Websim Edition" }, void 0, false, {
        fileName: "<stdin>",
        lineNumber: 203,
        columnNumber: 9
      }, this),
      /* @__PURE__ */ jsxDEV("div", { className: "subtle", children: [
        "New prompt every 24h \u2022 next in ",
        hh,
        ":",
        mm,
        ":",
        ss,
        " UTC"
      ] }, void 0, true, {
        fileName: "<stdin>",
        lineNumber: 204,
        columnNumber: 9
      }, this)
    ] }, void 0, true, {
      fileName: "<stdin>",
      lineNumber: 202,
      columnNumber: 7
    }, this),
    currentEvent ? /* @__PURE__ */ jsxDEV("div", { className: "row", children: [
      /* @__PURE__ */ jsxDEV("span", { className: "badge", children: [
        "#",
        currentEvent.id
      ] }, void 0, true, {
        fileName: "<stdin>",
        lineNumber: 208,
        columnNumber: 11
      }, this),
      /* @__PURE__ */ jsxDEV("div", { className: "kbd", children: currentEvent.category }, void 0, false, {
        fileName: "<stdin>",
        lineNumber: 209,
        columnNumber: 11
      }, this),
      /* @__PURE__ */ jsxDEV("div", { className: "kbd", children: currentEvent.theme }, void 0, false, {
        fileName: "<stdin>",
        lineNumber: 210,
        columnNumber: 11
      }, this)
    ] }, void 0, true, {
      fileName: "<stdin>",
      lineNumber: 207,
      columnNumber: 9
    }, this) : /* @__PURE__ */ jsxDEV("div", { className: "subtle", children: "Loading event\u2026" }, void 0, false, {
      fileName: "<stdin>",
      lineNumber: 212,
      columnNumber: 11
    }, this)
  ] }, void 0, true, {
    fileName: "<stdin>",
    lineNumber: 201,
    columnNumber: 5
  }, this);
}
function EventSelector({ events, selectedId, onChange }) {
  return /* @__PURE__ */ jsxDEV("div", { className: "card", children: [
    /* @__PURE__ */ jsxDEV("label", { children: "Browse events" }, void 0, false, {
      fileName: "<stdin>",
      lineNumber: 220,
      columnNumber: 7
    }, this),
    /* @__PURE__ */ jsxDEV("select", { value: selectedId, onChange: (e) => onChange(e.target.value), children: events.map((ev) => /* @__PURE__ */ jsxDEV("option", { value: ev.id, children: [
      "#",
      ev.id,
      " \u2014 ",
      ev.category,
      " \xB7 ",
      ev.theme
    ] }, ev.id, true, {
      fileName: "<stdin>",
      lineNumber: 223,
      columnNumber: 11
    }, this)) }, void 0, false, {
      fileName: "<stdin>",
      lineNumber: 221,
      columnNumber: 7
    }, this)
  ] }, void 0, true, {
    fileName: "<stdin>",
    lineNumber: 219,
    columnNumber: 5
  }, this);
}
function EntryForm({ selectedEvent, entry, onSave }) {
  const sub = (entry?.submissions || {})[selectedEvent?.id] || { title: "", url: "", description: "" };
  const [title, setTitle] = useState(sub.title);
  const [url, setUrl] = useState(sub.url);
  const [desc, setDesc] = useState(sub.description);
  useEffect(() => {
    const s = (entry?.submissions || {})[selectedEvent?.id] || {};
    setTitle(s.title || "");
    setUrl(s.url || "");
    setDesc(s.description || "");
  }, [selectedEvent?.id, JSON.stringify(entry?.submissions || {})]);
  return /* @__PURE__ */ jsxDEV("div", { className: "card", children: [
    /* @__PURE__ */ jsxDEV("div", { className: "row", style: { justifyContent: "space-between" }, children: [
      /* @__PURE__ */ jsxDEV("div", { style: { fontWeight: 700 }, children: "Submit / Update your entry" }, void 0, false, {
        fileName: "<stdin>",
        lineNumber: 248,
        columnNumber: 9
      }, this),
      /* @__PURE__ */ jsxDEV("span", { className: "subtle", children: "One row per user. Your entry updates automatically." }, void 0, false, {
        fileName: "<stdin>",
        lineNumber: 249,
        columnNumber: 9
      }, this)
    ] }, void 0, true, {
      fileName: "<stdin>",
      lineNumber: 247,
      columnNumber: 7
    }, this),
    /* @__PURE__ */ jsxDEV("div", { className: "divider" }, void 0, false, {
      fileName: "<stdin>",
      lineNumber: 251,
      columnNumber: 7
    }, this),
    /* @__PURE__ */ jsxDEV("div", { style: { display: "grid", gap: 10 }, children: [
      /* @__PURE__ */ jsxDEV("div", { children: [
        /* @__PURE__ */ jsxDEV("label", { children: "Title" }, void 0, false, {
          fileName: "<stdin>",
          lineNumber: 254,
          columnNumber: 11
        }, this),
        /* @__PURE__ */ jsxDEV("input", { type: "text", placeholder: "My Great Jam Game", value: title, onChange: (e) => setTitle(e.target.value) }, void 0, false, {
          fileName: "<stdin>",
          lineNumber: 255,
          columnNumber: 11
        }, this)
      ] }, void 0, true, {
        fileName: "<stdin>",
        lineNumber: 253,
        columnNumber: 9
      }, this),
      /* @__PURE__ */ jsxDEV("div", { children: [
        /* @__PURE__ */ jsxDEV("label", { children: "Playable URL" }, void 0, false, {
          fileName: "<stdin>",
          lineNumber: 258,
          columnNumber: 11
        }, this),
        /* @__PURE__ */ jsxDEV("input", { type: "url", placeholder: "https://...", value: url, onChange: (e) => setUrl(e.target.value) }, void 0, false, {
          fileName: "<stdin>",
          lineNumber: 259,
          columnNumber: 11
        }, this)
      ] }, void 0, true, {
        fileName: "<stdin>",
        lineNumber: 257,
        columnNumber: 9
      }, this),
      /* @__PURE__ */ jsxDEV("div", { children: [
        /* @__PURE__ */ jsxDEV("label", { children: "Description" }, void 0, false, {
          fileName: "<stdin>",
          lineNumber: 262,
          columnNumber: 11
        }, this),
        /* @__PURE__ */ jsxDEV("textarea", { rows: 4, placeholder: "Short description...", value: desc, onChange: (e) => setDesc(e.target.value) }, void 0, false, {
          fileName: "<stdin>",
          lineNumber: 263,
          columnNumber: 11
        }, this)
      ] }, void 0, true, {
        fileName: "<stdin>",
        lineNumber: 261,
        columnNumber: 9
      }, this),
      /* @__PURE__ */ jsxDEV("div", { className: "row", style: { justifyContent: "flex-end" }, children: /* @__PURE__ */ jsxDEV("button", { onClick: () => onSave({ title, url, description: desc }), disabled: !selectedEvent, children: "Save Entry" }, void 0, false, {
        fileName: "<stdin>",
        lineNumber: 266,
        columnNumber: 11
      }, this) }, void 0, false, {
        fileName: "<stdin>",
        lineNumber: 265,
        columnNumber: 9
      }, this)
    ] }, void 0, true, {
      fileName: "<stdin>",
      lineNumber: 252,
      columnNumber: 7
    }, this)
  ] }, void 0, true, {
    fileName: "<stdin>",
    lineNumber: 246,
    columnNumber: 5
  }, this);
}
function useLeaderboardData(selectedEvent) {
  const query = selectedEvent ? room.query(
    `with counts as (
      select u.entry_user_id, count(u.id) as c
      from public.upvote u
      where u.event_id = $1
      group by u.entry_user_id
    )
    select j.id as entry_user_id, j.submissions, j.created_at, c.c as votes
    from public.jam_entry j
    left join counts c on (c.entry_user_id = j.id)
    order by coalesce(c.c, 0) desc, j.created_at asc`,
    [selectedEvent.id]
  ) : null;
  const { data: rows = [], loading } = useQuery(query || room.query(`select * from public.jam_entry limit 0`));
  return { rows, loading };
}
function UpvoteButton({ entryUserId, eventId, currentUserId }) {
  const voteId = `${currentUserId}-${entryUserId}-${eventId}`;
  const { data: myVote = [] } = useQuery(
    room.collection("upvote").filter({ id: voteId })
  );
  const hasVoted = myVote.length > 0;
  async function toggle() {
    if (hasVoted) {
      await room.collection("upvote").delete(voteId);
    } else {
      await room.collection("upvote").upsert({
        id: voteId,
        entry_user_id: entryUserId,
        event_id: eventId
      });
    }
  }
  return /* @__PURE__ */ jsxDEV("button", { className: hasVoted ? "" : "ghost", onClick: toggle, children: hasVoted ? "\u2713 Upvoted" : "Upvote" }, void 0, false, {
    fileName: "<stdin>",
    lineNumber: 315,
    columnNumber: 5
  }, this);
}
function Leaderboard({ rows, selectedEvent, currentUserId }) {
  return /* @__PURE__ */ jsxDEV("div", { className: "card", children: [
    /* @__PURE__ */ jsxDEV("div", { className: "row", style: { justifyContent: "space-between" }, children: [
      /* @__PURE__ */ jsxDEV("div", { style: { fontWeight: 700 }, children: "Leaderboard" }, void 0, false, {
        fileName: "<stdin>",
        lineNumber: 325,
        columnNumber: 9
      }, this),
      /* @__PURE__ */ jsxDEV("div", { className: "subtle", children: [
        rows.length,
        " users"
      ] }, void 0, true, {
        fileName: "<stdin>",
        lineNumber: 326,
        columnNumber: 9
      }, this)
    ] }, void 0, true, {
      fileName: "<stdin>",
      lineNumber: 324,
      columnNumber: 7
    }, this),
    /* @__PURE__ */ jsxDEV("div", { className: "divider" }, void 0, false, {
      fileName: "<stdin>",
      lineNumber: 328,
      columnNumber: 7
    }, this),
    /* @__PURE__ */ jsxDEV("div", { children: rows.map((r) => {
      const s = (r.submissions || {})[selectedEvent.id];
      const disabled = !s || !s.title || !s.url;
      return /* @__PURE__ */ jsxDEV("div", { className: "item", "aria-disabled": disabled, children: [
        /* @__PURE__ */ jsxDEV("img", { className: "avatar", src: `https://images.websim.com/avatar/${r.entry_user_id}`, alt: "" }, void 0, false, {
          fileName: "<stdin>",
          lineNumber: 335,
          columnNumber: 15
        }, this),
        /* @__PURE__ */ jsxDEV("div", { children: [
          /* @__PURE__ */ jsxDEV("div", { className: "title", children: s?.title || /* @__PURE__ */ jsxDEV("span", { className: "subtle", children: "(no submission yet)" }, void 0, false, {
            fileName: "<stdin>",
            lineNumber: 337,
            columnNumber: 53
          }, this) }, void 0, false, {
            fileName: "<stdin>",
            lineNumber: 337,
            columnNumber: 17
          }, this),
          /* @__PURE__ */ jsxDEV("div", { className: "meta", children: [
            s?.description ? s.description + " \xB7 " : "",
            s?.url ? /* @__PURE__ */ jsxDEV("a", { href: s.url, target: "_blank", rel: "noreferrer", children: "Play" }, void 0, false, {
              fileName: "<stdin>",
              lineNumber: 340,
              columnNumber: 29
            }, this) : null
          ] }, void 0, true, {
            fileName: "<stdin>",
            lineNumber: 338,
            columnNumber: 17
          }, this)
        ] }, void 0, true, {
          fileName: "<stdin>",
          lineNumber: 336,
          columnNumber: 15
        }, this),
        /* @__PURE__ */ jsxDEV("div", { style: { display: "grid", justifyItems: "end", gap: 6 }, children: [
          /* @__PURE__ */ jsxDEV("div", { className: "kbd", "aria-label": "votes", children: [
            String(r.votes || 0),
            " votes"
          ] }, void 0, true, {
            fileName: "<stdin>",
            lineNumber: 344,
            columnNumber: 17
          }, this),
          !disabled && currentUserId ? /* @__PURE__ */ jsxDEV(UpvoteButton, { entryUserId: r.entry_user_id, eventId: selectedEvent.id, currentUserId }, void 0, false, {
            fileName: "<stdin>",
            lineNumber: 346,
            columnNumber: 19
          }, this) : /* @__PURE__ */ jsxDEV("button", { className: "ghost", disabled: true, children: "Upvote" }, void 0, false, {
            fileName: "<stdin>",
            lineNumber: 347,
            columnNumber: 21
          }, this)
        ] }, void 0, true, {
          fileName: "<stdin>",
          lineNumber: 343,
          columnNumber: 15
        }, this)
      ] }, r.entry_user_id, true, {
        fileName: "<stdin>",
        lineNumber: 334,
        columnNumber: 13
      }, this);
    }) }, void 0, false, {
      fileName: "<stdin>",
      lineNumber: 329,
      columnNumber: 7
    }, this)
  ] }, void 0, true, {
    fileName: "<stdin>",
    lineNumber: 323,
    columnNumber: 5
  }, this);
}
function App() {
  const [bootstrapped, setBootstrapped] = useState(false);
  const [busy, setBusy] = useState(false);
  const { events } = useEvents();
  const { selected, selectedId, setSelectedId } = useSelectedEvent(events);
  const { entry, currentUserId, backupLocal } = useJamEntrySync();
  const { rows, loading: lbLoading } = useLeaderboardData(selected || { id: "" });
  useEffect(() => {
    (async () => {
      await ensureTodayEvent();
      setBootstrapped(true);
    })();
  }, []);
  async function handleSave(sub) {
    if (!selected || !entry) return;
    setBusy(true);
    try {
      const submissions = { ...entry.submissions || {} };
      submissions[selected.id] = {
        ...submissions[selected.id] || {},
        ...sub,
        updated_at: ts()
      };
      const updated = await room.collection("jam_entry").upsert({
        id: entry.id,
        submissions,
        history: [
          ...entry.history || [],
          { ts: ts(), action: "update_submission", by: entry.id, event: selected.id, data: sub }
        ],
        backup_ts: ts()
      });
      backupLocal(updated);
    } finally {
      setBusy(false);
    }
  }
  return /* @__PURE__ */ jsxDEV("div", { className: "container", children: [
    /* @__PURE__ */ jsxDEV(Header, { currentEvent: events.find((e) => e.id === todayId()) }, void 0, false, {
      fileName: "<stdin>",
      lineNumber: 400,
      columnNumber: 7
    }, this),
    /* @__PURE__ */ jsxDEV("div", { className: "grid", children: [
      /* @__PURE__ */ jsxDEV("div", { style: { display: "grid", gap: 16 }, children: [
        /* @__PURE__ */ jsxDEV(EventSelector, { events, selectedId, onChange: setSelectedId }, void 0, false, {
          fileName: "<stdin>",
          lineNumber: 403,
          columnNumber: 11
        }, this),
        selected && entry ? /* @__PURE__ */ jsxDEV(EntryForm, { selectedEvent: selected, entry, onSave: handleSave }, void 0, false, {
          fileName: "<stdin>",
          lineNumber: 405,
          columnNumber: 13
        }, this) : /* @__PURE__ */ jsxDEV("div", { className: "card", children: "Loading your entry\u2026" }, void 0, false, {
          fileName: "<stdin>",
          lineNumber: 407,
          columnNumber: 13
        }, this),
        /* @__PURE__ */ jsxDEV(Leaderboard, { rows, selectedEvent: selected || { id: "" }, currentUserId }, void 0, false, {
          fileName: "<stdin>",
          lineNumber: 409,
          columnNumber: 11
        }, this)
      ] }, void 0, true, {
        fileName: "<stdin>",
        lineNumber: 402,
        columnNumber: 9
      }, this),
      /* @__PURE__ */ jsxDEV("div", { style: { display: "grid", gap: 16 }, children: [
        /* @__PURE__ */ jsxDEV("div", { className: "card", children: [
          /* @__PURE__ */ jsxDEV("div", { style: { fontWeight: 700 }, children: "About" }, void 0, false, {
            fileName: "<stdin>",
            lineNumber: 413,
            columnNumber: 13
          }, this),
          /* @__PURE__ */ jsxDEV("div", { className: "divider" }, void 0, false, {
            fileName: "<stdin>",
            lineNumber: 414,
            columnNumber: 13
          }, this),
          /* @__PURE__ */ jsxDEV("p", { className: "subtle", children: "Daily Category + Theme is generated at 00:00 UTC. First client online seeds it (race-safe)." }, void 0, false, {
            fileName: "<stdin>",
            lineNumber: 415,
            columnNumber: 13
          }, this),
          /* @__PURE__ */ jsxDEV("p", { className: "subtle", children: "Each user has one persistent row. Submissions are stored per event in JSON, with append-only history." }, void 0, false, {
            fileName: "<stdin>",
            lineNumber: 418,
            columnNumber: 13
          }, this),
          /* @__PURE__ */ jsxDEV("p", { className: "subtle", children: "Your data is also backed up to localStorage and auto-merged by timestamps." }, void 0, false, {
            fileName: "<stdin>",
            lineNumber: 421,
            columnNumber: 13
          }, this)
        ] }, void 0, true, {
          fileName: "<stdin>",
          lineNumber: 412,
          columnNumber: 11
        }, this),
        /* @__PURE__ */ jsxDEV("div", { className: "card", children: [
          /* @__PURE__ */ jsxDEV("div", { style: { fontWeight: 700 }, children: "Status" }, void 0, false, {
            fileName: "<stdin>",
            lineNumber: 426,
            columnNumber: 13
          }, this),
          /* @__PURE__ */ jsxDEV("div", { className: "divider" }, void 0, false, {
            fileName: "<stdin>",
            lineNumber: 427,
            columnNumber: 13
          }, this),
          /* @__PURE__ */ jsxDEV("div", { className: "row", children: [
            /* @__PURE__ */ jsxDEV("span", { className: "badge", children: "Bootstrap" }, void 0, false, {
              fileName: "<stdin>",
              lineNumber: 428,
              columnNumber: 34
            }, this),
            /* @__PURE__ */ jsxDEV("span", { className: "subtle", children: bootstrapped ? "Ready" : "Seeding\u2026" }, void 0, false, {
              fileName: "<stdin>",
              lineNumber: 428,
              columnNumber: 74
            }, this)
          ] }, void 0, true, {
            fileName: "<stdin>",
            lineNumber: 428,
            columnNumber: 13
          }, this),
          /* @__PURE__ */ jsxDEV("div", { className: "row", children: [
            /* @__PURE__ */ jsxDEV("span", { className: "badge", children: "Saving" }, void 0, false, {
              fileName: "<stdin>",
              lineNumber: 429,
              columnNumber: 34
            }, this),
            /* @__PURE__ */ jsxDEV("span", { className: "subtle", children: busy ? "\u2026" : "Idle" }, void 0, false, {
              fileName: "<stdin>",
              lineNumber: 429,
              columnNumber: 71
            }, this)
          ] }, void 0, true, {
            fileName: "<stdin>",
            lineNumber: 429,
            columnNumber: 13
          }, this),
          /* @__PURE__ */ jsxDEV("div", { className: "row", children: [
            /* @__PURE__ */ jsxDEV("span", { className: "badge", children: "Leaderboard" }, void 0, false, {
              fileName: "<stdin>",
              lineNumber: 430,
              columnNumber: 34
            }, this),
            /* @__PURE__ */ jsxDEV("span", { className: "subtle", children: lbLoading ? "Loading\u2026" : "Live" }, void 0, false, {
              fileName: "<stdin>",
              lineNumber: 430,
              columnNumber: 76
            }, this)
          ] }, void 0, true, {
            fileName: "<stdin>",
            lineNumber: 430,
            columnNumber: 13
          }, this)
        ] }, void 0, true, {
          fileName: "<stdin>",
          lineNumber: 425,
          columnNumber: 11
        }, this)
      ] }, void 0, true, {
        fileName: "<stdin>",
        lineNumber: 411,
        columnNumber: 9
      }, this)
    ] }, void 0, true, {
      fileName: "<stdin>",
      lineNumber: 401,
      columnNumber: 7
    }, this),
    /* @__PURE__ */ jsxDEV("div", { className: "footer-note", children: "Clean UI \u2022 Upvote-only \u2022 Append-only history" }, void 0, false, {
      fileName: "<stdin>",
      lineNumber: 434,
      columnNumber: 7
    }, this)
  ] }, void 0, true, {
    fileName: "<stdin>",
    lineNumber: 399,
    columnNumber: 5
  }, this);
}
const root = createRoot(document.getElementById("root"));
root.render(/* @__PURE__ */ jsxDEV(App, {}, void 0, false, {
  fileName: "<stdin>",
  lineNumber: 440,
  columnNumber: 13
}));
