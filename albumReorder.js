// NAME: Album Reorder
// DESCRIPTION: Drag tracks on an album page to give the album your own track order. The album page shows it and playback follows it.
// VERSION: 1.1.0

/// <reference path="../globals.d.ts" />

(function albumReorder() {
	if (!Spicetify?.Platform?.PlayerAPI || !Spicetify.Platform.History || !Spicetify.LocalStorage || !document.body) {
		setTimeout(albumReorder, 300);
		return;
	}

	const LOG = "[album-reorder]";
	const STORAGE_KEY = "album-reorder:orders";
	// Newest Spotify layout first; later entries cover older builds.
	const GRID_SELECTORS = ['[data-testid="album-page"] [role="grid"]', '.main-view-container [role="grid"]', '[data-testid="track-list"]'];
	const ACTION_BAR_SELECTORS = [
		'[data-testid="album-page"] [data-testid="action-bar-row"]',
		'.main-view-container [data-testid="action-bar-row"]',
		".main-actionBar-ActionBarRow",
	];
	const DROP_ATTR = "data-album-reorder-drop";
	const FORCED_ATTR = "data-album-reorder-forced";
	const RESET_ID = "album-reorder-reset";
	const TOAST_ID = "album-reorder-toast";
	const DELIMITER = "spotify:delimiter";
	// Rewritten album data keeps each track's real position here: { disc, number }.
	const ORIGINAL_KEY = "albumReorderOriginal";
	// Spotify keeps ~80 upcoming tracks loaded. Keep the next QUEUE_CHECK in the custom order,
	// refilling up to QUEUE_WINDOW at a time.
	const QUEUE_CHECK = 20;
	const QUEUE_WINDOW = 60;
	const playerApi = Spicetify.Platform.PlayerAPI;

	// ---------------------------------------------------------------------------
	// Saved orders: { [albumUri]: { order: trackUri[], original: trackUri[] } }
	// ---------------------------------------------------------------------------

	let orders = loadOrders();

	function loadOrders() {
		try {
			const parsed = JSON.parse(Spicetify.LocalStorage.get(STORAGE_KEY) || "{}");
			return parsed && typeof parsed === "object" ? parsed : {};
		} catch {
			return {};
		}
	}

	function saveOrders() {
		Spicetify.LocalStorage.set(STORAGE_KEY, JSON.stringify(orders));
	}

	function getEntry(albumUri) {
		const entry = typeof albumUri === "string" ? orders[albumUri] : null;
		return entry && Array.isArray(entry.order) && Array.isArray(entry.original) ? entry : null;
	}

	function setOrder(albumUri, order, original) {
		if (arraysEqual(order, original)) delete orders[albumUri];
		else orders[albumUri] = { order, original };
		saveOrders();
	}

	// ---------------------------------------------------------------------------
	// Helpers
	// ---------------------------------------------------------------------------

	function arraysEqual(a, b) {
		return a.length === b.length && a.every((v, i) => v === b[i]);
	}

	function startsWith(list, prefix) {
		return list.length >= prefix.length && prefix.every((v, i) => v === list[i]);
	}

	// Keeps a saved order valid if the album's track list changed since it was saved.
	function reconcile(order, original) {
		const known = new Set(original);
		const out = order.filter((uri) => known.has(uri));
		for (const uri of original) if (!out.includes(uri)) out.push(uri);
		return out;
	}

	// Returns `items` sorted by `order`, or null if that can't be done cleanly.
	function applyOrder(items, getUri, order) {
		const buckets = new Map();
		for (const item of items) {
			const uri = getUri(item);
			if (!buckets.has(uri)) buckets.set(uri, []);
			buckets.get(uri).push(item);
		}
		const out = [];
		for (const uri of order) {
			const bucket = buckets.get(uri);
			if (bucket?.length) out.push(bucket.shift());
		}
		const placed = new Set(out);
		for (const item of items) if (!placed.has(item)) out.push(item);
		return out.length === items.length ? out : null;
	}

	function albumUriFromPath(pathname) {
		const match = /^\/album\/([A-Za-z0-9]+)/.exec(pathname || "");
		return match ? `spotify:album:${match[1]}` : null;
	}

	function currentAlbumUri() {
		return albumUriFromPath(Spicetify.Platform.History.location?.pathname);
	}

	function findFirst(selectors) {
		for (const selector of selectors) {
			const el = document.querySelector(selector);
			if (el) return el;
		}
		return null;
	}

	function findAlbumGrid() {
		return currentAlbumUri() ? findFirst(GRID_SELECTORS) : null;
	}

	function reactFiber(el) {
		const key = el && Object.keys(el).find((k) => k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$"));
		return key ? el[key] : null;
	}

	function scrollParent(el) {
		for (let node = el?.parentElement; node; node = node.parentElement) {
			if (/(auto|scroll)/.test(getComputedStyle(node).overflowY) && node.scrollHeight > node.clientHeight) return node;
		}
		return null;
	}

	// Spicetify.showNotification isn't available on every Spotify version, so fall back to our own toast.
	let toastTimer = null;
	function notify(message, isError = false) {
		if (typeof Spicetify.showNotification === "function") {
			try {
				Spicetify.showNotification(message, isError);
				return;
			} catch {}
		}
		let toast = document.getElementById(TOAST_ID);
		if (!toast) {
			toast = document.createElement("div");
			toast.id = TOAST_ID;
			toast.setAttribute("role", "status");
			document.body.appendChild(toast);
		}
		toast.textContent = message;
		toast.classList.toggle("is-error", isError);
		toast.classList.add("is-visible");
		clearTimeout(toastTimer);
		toastTimer = setTimeout(() => toast.classList.remove("is-visible"), 3000);
	}

	// ---------------------------------------------------------------------------
	// Album track data (original order)
	// ---------------------------------------------------------------------------

	const trackCache = new Map();

	async function fetchTracksGraphQL(albumUri) {
		const query = Spicetify.GraphQL?.Definitions?.queryAlbumTracks;
		if (!query || typeof Spicetify.GraphQL.Request !== "function") return null;
		const tracks = [];
		let rewritten = false;
		for (let offset = 0; ; ) {
			const { data, errors } = await Spicetify.GraphQL.Request(query, { uri: albumUri, offset, limit: 100 });
			if (errors?.length) throw new Error(errors[0].message);
			const list = data?.albumUnion?.tracksV2 ?? data?.albumUnion?.tracks;
			const items = list?.items ?? [];
			for (const { track } of items) {
				const original = track[ORIGINAL_KEY];
				rewritten ||= !!original;
				tracks.push({
					uri: track.uri,
					name: track.name,
					disc: original?.disc ?? track.discNumber ?? 1,
					number: original?.number ?? track.trackNumber ?? 0,
					playable: track.playability?.playable !== false,
				});
			}
			offset += items.length;
			if (!items.length || offset >= (list?.totalCount ?? 0)) break;
		}
		// Our fetch hook may have served this in the custom order; put it back in album order.
		if (rewritten) tracks.sort((a, b) => a.disc - b.disc || a.number - b.number);
		return tracks;
	}

	async function fetchTracksWebApi(albumUri) {
		if (typeof Spicetify.CosmosAsync?.get !== "function") return null;
		const id = albumUri.split(":").pop();
		const tracks = [];
		for (let offset = 0; ; offset += 50) {
			const page = await Spicetify.CosmosAsync.get(`https://api.spotify.com/v1/albums/${id}/tracks?limit=50&offset=${offset}`);
			for (const t of page?.items ?? []) {
				tracks.push({ uri: t.uri, name: t.name, disc: t.disc_number ?? 1, number: t.track_number ?? 0, playable: t.is_playable !== false });
			}
			if (!page?.next) break;
		}
		return tracks;
	}

	function getAlbumTracks(albumUri) {
		if (trackCache.has(albumUri)) return trackCache.get(albumUri);
		const promise = (async () => {
			let tracks = null;
			try {
				tracks = await fetchTracksGraphQL(albumUri);
			} catch (err) {
				console.warn(LOG, "GraphQL track lookup failed, trying the Web API", err);
			}
			if (!tracks?.length) tracks = await fetchTracksWebApi(albumUri);
			if (!tracks?.length) throw new Error("Couldn't load this album's tracks");
			return tracks;
		})();
		trackCache.set(albumUri, promise);
		promise.catch(() => trackCache.delete(albumUri));
		return promise;
	}

	// ---------------------------------------------------------------------------
	// Album data: serve every list of an album's tracks in the custom order
	// ---------------------------------------------------------------------------

	function albumTrackList(json) {
		const album = json?.data?.albumUnion;
		const list = album?.tracksV2 ?? album?.tracks;
		const items = list?.items;
		return Array.isArray(items) && items.length && items.every((it) => typeof it?.track?.uri === "string") ? list : null;
	}

	// Long albums come in pages. Fetch the whole album by replaying the same request page by page.
	const fullAlbumCache = new Map(); // `${operation}|${albumUri}` -> { time, promise }

	function allAlbumItems(albumUri, request, input, init, firstPage) {
		const key = `${request.operationName}|${albumUri}`;
		const cached = fullAlbumCache.get(key);
		if (cached && Date.now() - cached.time < 60000) return cached.promise;
		const promise = (async () => {
			const total = firstPage.totalCount ?? 0;
			const pageSize = Math.max(Number(request.variables.limit) || 0, firstPage.items.length, 1);
			const items = [];
			for (let offset = 0; offset < total; offset += pageSize) {
				const body = JSON.stringify({ ...request, variables: { ...request.variables, offset, limit: pageSize } });
				const response = await originalFetch.call(window, input, { ...init, body });
				if (!response.ok) throw new Error(`HTTP ${response.status}`);
				const list = albumTrackList(await response.json());
				if (!list) break;
				items.push(...list.items);
			}
			return items;
		})();
		fullAlbumCache.set(key, { time: Date.now(), promise });
		promise.catch(() => fullAlbumCache.delete(key));
		return promise;
	}

	function renumber(item, number) {
		const track = item.track;
		const original = track[ORIGINAL_KEY] ?? { disc: track.discNumber, number: track.trackNumber };
		const numbers = "trackNumber" in track ? { trackNumber: number, discNumber: 1 } : {};
		return { ...item, track: { ...track, ...numbers, [ORIGINAL_KEY]: original } };
	}

	async function reorderAlbumResponse(json, request, input, init) {
		const albumUri = request.variables?.uri;
		const entry = getEntry(albumUri);
		const page = entry && albumTrackList(json);
		if (!page) return false;
		const offset = Number(request.variables.offset) || 0;
		const total = page.totalCount ?? page.items.length;
		const all = offset === 0 && page.items.length >= total ? page.items : await allAlbumItems(albumUri, request, input, init, page);
		if (!all || all.length < total) return false;
		const sorted = applyOrder(all, (it) => it.track.uri, entry.order);
		if (!sorted) return false;
		page.items = sorted.slice(offset, offset + page.items.length).map((it, i) => renumber(it, offset + i + 1));
		const album = json.data.albumUnion;
		if (album.discs?.items?.length) {
			const first = album.discs.items[0];
			album.discs = { ...album.discs, totalCount: 1, items: [{ ...first, number: 1, tracks: { ...(first.tracks ?? {}), totalCount: total } }] };
		}
		return true;
	}

	const originalFetch = window.fetch;
	window.fetch = async function (input, init) {
		const response = await originalFetch.apply(window, arguments);
		try {
			const body = init?.body;
			if (typeof body !== "string" || !response.ok || !body.includes("spotify:album:")) return response;
			const request = JSON.parse(body);
			if (!getEntry(request?.variables?.uri)) return response;
			const json = await response.clone().json();
			if (!(await reorderAlbumResponse(json, request, input, init))) return response;
			const headers = new Headers(response.headers);
			headers.delete("content-length");
			headers.delete("content-encoding");
			return new Response(JSON.stringify(json), { status: response.status, statusText: response.statusText, headers });
		} catch (err) {
			console.warn(LOG, "couldn't reorder album data", err);
			return response;
		}
	};

	// ---------------------------------------------------------------------------
	// Album page: show a new order straight away
	// ---------------------------------------------------------------------------

	// Spotify keeps album pages in a TanStack Query cache; updating it re-renders the page instantly.
	let queryClient = null;

	function findQueryClient() {
		if (queryClient) return queryClient;
		const start = findAlbumGrid() ?? findFirst([".main-view-container", "#main", "body > div"]);
		for (let fiber = reactFiber(start), i = 0; fiber && i < 3000; fiber = fiber.return, i++) {
			const props = fiber.memoizedProps;
			const client = props?.client ?? props?.value;
			if (client && typeof client.getQueryCache === "function" && typeof client.setQueryData === "function") {
				queryClient = client;
				return client;
			}
		}
		return null;
	}

	function albumPageQuery(albumUri) {
		return (query) => query.queryKey?.[0] === "getAlbum" && query.queryKey?.[1]?.uri === albumUri;
	}

	function anyAlbumQuery(albumUri) {
		return (query) => query.queryKey?.[1]?.uri === albumUri;
	}

	// Puts Spotify's album model (the cached getAlbum result) in `order`, shaped the way Spotify builds
	// it: multi-disc albums list an { type: "AlbumDisc" } header before each disc's tracks; a custom
	// order is one disc with no headers. Pass `originalTracks` when restoring the original order so
	// the real track numbers and disc headers come back.
	function albumModelInOrder(model, order, originalTracks) {
		if (!model || !Array.isArray(model.items)) return null;
		const tracks = model.items.filter((it) => typeof it?.uri === "string");
		if (typeof model.nrTracks === "number" && tracks.length < model.nrTracks) return null;
		const sorted = applyOrder(tracks, (it) => it.uri, order);
		if (!sorted) return null;
		const discTemplate = model.discs?.items?.[0] ?? { type: "AlbumDisc" };
		const disc = (discNumber, nrTracks) => ({ ...discTemplate, discNumber, nrTracks });

		if (!originalTracks) {
			const discs = model.discs ? { ...model.discs, totalCount: 1, items: [disc(1, sorted.length)] } : model.discs;
			return { ...model, items: sorted.map((it, i) => ({ ...it, trackNumber: i + 1, discNumber: 1 })), discs };
		}

		const info = new Map(originalTracks.map((t) => [t.uri, t]));
		const renumbered = sorted.map((it) => {
			const track = info.get(it.uri);
			return track ? { ...it, trackNumber: track.number, discNumber: track.disc } : it;
		});
		const perDisc = new Map();
		for (const it of renumbered) perDisc.set(it.discNumber ?? 1, (perDisc.get(it.discNumber ?? 1) ?? 0) + 1);
		const multiDisc = perDisc.size > 1;
		const items = [];
		let currentDisc = null;
		for (const it of renumbered) {
			if (multiDisc && it.discNumber !== currentDisc) {
				currentDisc = it.discNumber;
				items.push(disc(currentDisc, perDisc.get(currentDisc)));
			}
			items.push(it);
		}
		const discs = model.discs ? { ...model.discs, totalCount: perDisc.size, items: [...perDisc].map(([n, count]) => disc(n, count)) } : model.discs;
		return { ...model, items, discs };
	}

	// The album tracklist copies its tracks into its own item cache: { items: [{ value, index }] },
	// re-rendered through a counter state. Returns those two, or null if the shape isn't recognised.
	function findTracklistCache() {
		for (let fiber = reactFiber(findAlbumGrid()), i = 0; fiber && i < 40; fiber = fiber.return, i++) {
			const props = fiber.memoizedProps;
			if (!Array.isArray(props?.tracks) || typeof props.fetchTracks !== "function") continue;
			let cache = null;
			let rerender = null;
			for (let hook = fiber.memoizedState; hook; hook = hook.next) {
				const state = hook.memoizedState;
				if (!cache && Array.isArray(state?.current?.items)) cache = state.current;
				if (!rerender && typeof state === "number" && typeof hook.queue?.dispatch === "function") rerender = hook.queue.dispatch;
			}
			const slots = cache?.items;
			if (!rerender || !slots?.every((slot, index) => slot && "value" in slot && slot.index === index)) return null;
			return { slots, rerender };
		}
		return null;
	}

	// Copies Spotify's (reordered) album data into the mounted tracklist's item cache, in place, so
	// the list updates without losing its scroll position. Spotify sometimes resets that cache to the
	// tracks it first mounted with (e.g. when the disc layout changes), so this also runs whenever
	// the page re-renders. Returns false if the tracklist isn't one we know how to update.
	const touchedAlbums = new Set(); // albums reordered or reset since Spotify started
	let resyncTimes = [];

	function syncMountedTracklist(albumUri, force = false) {
		if (currentAlbumUri() !== albumUri || !findAlbumGrid()) return true;
		const list = findTracklistCache();
		const items = findQueryClient()
			?.getQueryCache()
			.findAll({ predicate: albumPageQuery(albumUri) })
			.map((query) => query.state.data?.items)
			.find((candidate) => Array.isArray(candidate) && candidate.length === list?.slots.length);
		if (!list || !items) return false;
		const inSync = list.slots.every(
			(slot, index) => slot.value?.uri === items[index]?.uri && slot.value?.trackNumber === items[index]?.trackNumber
		);
		if (inSync) return true;
		if (!force) {
			// Never get into a tug of war with Spotify.
			const now = Date.now();
			resyncTimes = resyncTimes.filter((time) => now - time < 3000);
			if (resyncTimes.length >= 6) return false;
			resyncTimes.push(now);
		}
		list.slots.forEach((slot, index) => {
			slot.value = items[index];
		});
		list.rerender((n) => n + 1);
		return true;
	}

	// Fallback for long albums and Spotify builds we can't update in place: briefly leave the page
	// and come back, so it loads again (through the fetch hook), then restore the scroll position.
	function remountAlbumPage() {
		const history = Spicetify.Platform.History;
		const location = history.location;
		const scrollTop = scrollParent(findAlbumGrid())?.scrollTop ?? 0;
		history.replace("/search");
		setTimeout(() => {
			history.replace(location);
			let tries = 0;
			const restore = () => {
				const scroller = scrollParent(findAlbumGrid());
				if (scroller && scroller.scrollHeight - scroller.clientHeight >= scrollTop) scroller.scrollTop = scrollTop;
				else if (++tries < 50) setTimeout(restore, 100);
			};
			restore();
		}, 50);
	}

	function refreshAlbumPage(albumUri, tracks) {
		touchedAlbums.add(albumUri);
		const onPage = currentAlbumUri() === albumUri;
		const client = findQueryClient();
		if (client) {
			const entry = getEntry(albumUri);
			const order = entry ? entry.order : tracks.map((t) => t.uri);
			let complete = true;
			let updated = false;
			for (const query of client.getQueryCache().findAll({ predicate: albumPageQuery(albumUri) })) {
				const model = albumModelInOrder(query.state.data, order, entry ? null : tracks);
				if (!model) {
					complete = false;
					continue;
				}
				client.setQueryData(query.queryKey, model);
				updated = true;
			}
			if (complete && (!onPage || (updated && syncMountedTracklist(albumUri, true)))) return;
			// Drop the cached copies so the page loads the album again, in the right order.
			client.removeQueries({ predicate: anyAlbumQuery(albumUri) });
		}
		if (onPage) remountAlbumPage();
	}

	// ---------------------------------------------------------------------------
	// Drag and drop on the album tracklist
	// ---------------------------------------------------------------------------

	const style = document.createElement("style");
	style.id = "album-reorder-style";
	style.textContent = `
		[${DROP_ATTR}] { position: relative; }
		[${DROP_ATTR}]::after {
			content: "";
			position: absolute;
			left: 0;
			right: 0;
			height: 2px;
			border-radius: 1px;
			background: var(--text-bright-accent, var(--spice-button, #1ed760));
			pointer-events: none;
			z-index: 2;
		}
		[${DROP_ATTR}="before"]::after { top: -1px; }
		[${DROP_ATTR}="after"]::after { bottom: -1px; }

		#${RESET_ID} {
			display: inline-flex;
			align-items: center;
			height: 32px;
			padding: 0 15px;
			margin-inline-start: 8px;
			border: 1px solid var(--essential-subdued, var(--spice-subtext, #7c7c7c));
			border-radius: 9999px;
			background: transparent;
			color: var(--text-base, var(--spice-text, #fff));
			font-family: inherit;
			font-size: 0.875rem;
			font-weight: 700;
			white-space: nowrap;
			cursor: pointer;
		}
		#${RESET_ID}:hover { border-color: var(--text-base, var(--spice-text, #fff)); transform: scale(1.04); }
		#${RESET_ID}:active { transform: scale(1); opacity: 0.7; }

		#${TOAST_ID} {
			position: fixed;
			left: 50%;
			bottom: 110px;
			z-index: 9999;
			max-width: min(480px, calc(100vw - 32px));
			padding: 10px 16px;
			border-radius: 8px;
			background: var(--text-base, var(--spice-text, #fff));
			color: var(--background-base, var(--spice-main, #121212));
			font-size: 0.875rem;
			box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
			opacity: 0;
			transform: translate(-50%, 8px);
			transition: opacity 0.2s, transform 0.2s;
			pointer-events: none;
		}
		#${TOAST_ID}.is-visible { opacity: 1; transform: translate(-50%, 0); }
		#${TOAST_ID}.is-error { background: var(--essential-negative, #e91429); color: #fff; }
	`;
	document.head.appendChild(style);

	let drag = null; // { albumUri, uris }
	let dropMark = null; // { row, position }

	function rowTrackUri(row) {
		for (let fiber = reactFiber(row.firstElementChild ?? row), i = 0; fiber && i < 30; fiber = fiber.return, i++) {
			const props = fiber.memoizedProps;
			const uri = props?.uri ?? props?.track?.uri ?? props?.item?.uri;
			if (typeof uri === "string" && /^spotify:(track|local):/.test(uri)) return uri;
		}
		return null;
	}

	function trackRowAt(target) {
		const grid = target instanceof Element ? findAlbumGrid() : null;
		if (!grid?.contains(target)) return {};
		const row = target.closest('[role="row"]');
		if (!row || !grid.contains(row) || row.getAttribute("aria-rowindex") === "1") return { grid };
		return { grid, row };
	}

	function setDropMark(row, position) {
		if (dropMark?.row === row && dropMark.position === position) return;
		clearDropMark();
		row.setAttribute(DROP_ATTR, position);
		dropMark = { row, position };
	}

	function clearDropMark() {
		dropMark?.row.removeAttribute(DROP_ATTR);
		dropMark = null;
	}

	function dropEffectFor(effectAllowed) {
		if (/move|all|uninitialized/i.test(effectAllowed)) return "move";
		if (/copy/i.test(effectAllowed)) return "copy";
		return "link";
	}

	// Spotify doesn't let you drag tracks it marks unavailable; allow it here so they can be moved too.
	document.addEventListener(
		"pointerdown",
		(e) => {
			const { row } = trackRowAt(e.target);
			const handle = row?.firstElementChild;
			if (handle?.getAttribute("draggable") === "false") {
				handle.setAttribute("draggable", "true");
				handle.setAttribute(FORCED_ATTR, "");
			}
		},
		true
	);

	document.addEventListener(
		"dragstart",
		(e) => {
			const { grid, row } = trackRowAt(e.target);
			const albumUri = currentAlbumUri();
			const uri = row && albumUri ? rowTrackUri(row) : null;
			if (!uri) return;
			let uris = [uri];
			if (row.getAttribute("aria-selected") === "true") {
				const selected = [...grid.querySelectorAll('[role="row"][aria-selected="true"]')].map(rowTrackUri).filter(Boolean);
				if (selected.includes(uri)) uris = selected;
			}
			drag = { albumUri, uris };
			getAlbumTracks(albumUri).catch(() => {});
			if (row.firstElementChild?.hasAttribute(FORCED_ATTR)) {
				e.stopPropagation();
				e.dataTransfer.effectAllowed = "move";
				e.dataTransfer.setData("text/plain", uri);
			}
		},
		true
	);

	document.addEventListener(
		"dragover",
		(e) => {
			if (!drag) return;
			const { row } = trackRowAt(e.target);
			if (!row || drag.albumUri !== currentAlbumUri()) {
				clearDropMark();
				return;
			}
			e.preventDefault();
			e.stopPropagation();
			e.dataTransfer.dropEffect = dropEffectFor(e.dataTransfer.effectAllowed);
			const uri = rowTrackUri(row);
			if (!uri || drag.uris.includes(uri)) {
				clearDropMark();
				return;
			}
			const rect = row.getBoundingClientRect();
			setDropMark(row, e.clientY > rect.top + rect.height / 2 ? "after" : "before");
		},
		true
	);

	document.addEventListener(
		"drop",
		(e) => {
			if (!drag) return;
			const current = drag;
			const mark = dropMark;
			clearDropMark();
			if (!mark || !trackRowAt(e.target).row) return;
			e.preventDefault();
			e.stopPropagation();
			drag = null;
			const targetUri = rowTrackUri(mark.row);
			moveTracks(current.albumUri, current.uris, targetUri, mark.position === "after").catch((err) => {
				console.error(LOG, err);
				notify(`Album Reorder: ${err.message ?? err}`, true);
			});
		},
		true
	);

	document.addEventListener(
		"dragend",
		() => {
			drag = null;
			clearDropMark();
		},
		true
	);

	async function moveTracks(albumUri, uris, targetUri, after) {
		if (!targetUri) return;
		const tracks = await getAlbumTracks(albumUri);
		const original = tracks.map((t) => t.uri);
		const entry = getEntry(albumUri);
		const shown = entry ? reconcile(entry.order, original) : original.slice();
		const moving = shown.filter((uri) => uris.includes(uri));
		if (!moving.length || moving.includes(targetUri) || !shown.includes(targetUri)) return;

		let insertAt = shown.indexOf(targetUri) + (after ? 1 : 0);
		insertAt -= shown.slice(0, insertAt).filter((uri) => moving.includes(uri)).length;
		const order = shown.filter((uri) => !moving.includes(uri));
		order.splice(insertAt, 0, ...moving);
		if (arraysEqual(order, shown)) return;

		setOrder(albumUri, order, original);
		syncResetButton();
		if (playerApi.getState?.()?.context?.uri === albumUri) openFixWindow();
		refreshAlbumPage(albumUri, tracks);

		const name = tracks.find((t) => t.uri === moving[0])?.name ?? "Track";
		const where = `#${order.indexOf(moving[0]) + 1}`;
		notify(moving.length > 1 ? `Moved ${moving.length} tracks to ${where}` : `Moved "${name}" to ${where}`);
	}

	async function resetOrder(albumUri) {
		const entry = getEntry(albumUri);
		if (!entry) return;
		delete orders[albumUri];
		saveOrders();
		syncResetButton();
		if (playerApi.getState?.()?.context?.uri === albumUri) {
			resetOverride = { albumUri, order: entry.original };
			openFixWindow();
		}
		const tracks = await getAlbumTracks(albumUri).catch(() => null);
		if (tracks) refreshAlbumPage(albumUri, tracks);
		notify("Back to the original track order");
	}

	// "Reset order" button in the album's action bar, shown while the album has a custom order.
	function syncResetButton() {
		const albumUri = currentAlbumUri();
		const bar = albumUri ? findFirst(ACTION_BAR_SELECTORS) : null;
		let button = document.getElementById(RESET_ID);
		if (!bar || !getEntry(albumUri)) {
			button?.remove();
			return;
		}
		if (button?.parentElement === bar && button.dataset.album === albumUri) return;
		button?.remove();
		button = document.createElement("button");
		button.id = RESET_ID;
		button.type = "button";
		button.dataset.album = albumUri;
		button.title = "Put this album back in its original track order";
		button.textContent = "Reset order";
		button.addEventListener("click", () => resetOrder(albumUri));
		const menuButtons = bar.querySelectorAll(":scope > button[aria-haspopup]");
		const anchor = menuButtons[menuButtons.length - 1];
		if (anchor) anchor.after(button);
		else bar.appendChild(button);
	}

	let syncQueued = false;
	new MutationObserver(() => {
		if (syncQueued) return;
		syncQueued = true;
		requestAnimationFrame(() => {
			syncQueued = false;
			try {
				syncResetButton();
				const albumUri = currentAlbumUri();
				if (albumUri && (getEntry(albumUri) || touchedAlbums.has(albumUri))) syncMountedTracklist(albumUri);
			} catch (err) {
				console.warn(LOG, err);
			}
		});
	}).observe(document.body, { childList: true, subtree: true });

	// Right-click "Reset track order" on albums too, once Spicetify's menu API is ready.
	(function registerContextMenu(triesLeft) {
		if (!Spicetify.ContextMenu?.Item || !Spicetify.ReactJSX) {
			if (triesLeft > 0) setTimeout(registerContextMenu, 500, triesLeft - 1);
			return;
		}
		try {
			new Spicetify.ContextMenu.Item(
				"Reset track order",
				([uri]) => resetOrder(uri),
				(uris) => uris?.length === 1 && !!getEntry(uris[0]),
				"x"
			).register();
		} catch (err) {
			console.warn(LOG, "context menu unavailable", err);
		}
	})(40);

	Spicetify.Platform.History.listen?.((location) => {
		const albumUri = albumUriFromPath(location?.pathname);
		if (albumUri) getAlbumTracks(albumUri).catch(() => {});
	});
	if (currentAlbumUri()) getAlbumTracks(currentAlbumUri()).catch(() => {});

	// ---------------------------------------------------------------------------
	// Playback: start albums at the custom first track, keep "Next up" in the custom order
	// ---------------------------------------------------------------------------

	if (typeof playerApi.play === "function") {
		const originalPlay = playerApi.play;
		playerApi.play = function (context, origin, options) {
			try {
				options = adjustPlayOptions(context, options);
			} catch (err) {
				console.warn(LOG, err);
			}
			return originalPlay.call(playerApi, context, origin, options);
		};
	}

	function adjustPlayOptions(context, options) {
		const entry = getEntry(context?.uri);
		if (!entry) return options;
		openFixWindow();
		const skipTo = options?.skipTo;
		const shuffling = options?.shuffle ?? playerApi.getState?.()?.shuffle;
		if (!skipTo || (!skipTo.uri && !skipTo.uid && !(skipTo.index > 0))) {
			// "Play album" with no track picked: start at the custom first track.
			if (shuffling) return options;
			const first = entry.order[0];
			const index = entry.original.indexOf(first);
			return index > 0 ? { ...options, skipTo: { uri: first, index } } : options;
		}
		if (skipTo.uri) {
			// Rows on a reordered album page report their displayed position; Spotify needs the real one.
			const index = entry.original.indexOf(skipTo.uri);
			if (index >= 0) return { ...options, skipTo: { ...skipTo, index } };
		}
		return options;
	}

	// Whenever an album with a custom order starts, changes track, or shuffle/repeat changes, Spotify
	// may fill "Next up" in the original order. For a short window afterwards, swap in the custom order.
	let fixWindowUntil = 0;
	let fixWindowId = 0;
	let checkTimer = null;
	let resetOverride = null; // { albumUri, order } – puts the original order back after a reset
	const fixAttempts = new Map();

	function openFixWindow(ms = 10000) {
		fixWindowUntil = Date.now() + ms;
		fixWindowId++;
		fixAttempts.clear();
		scheduleCheck(100);
	}

	function scheduleCheck(delay = 200) {
		clearTimeout(checkTimer);
		checkTimer = setTimeout(() => checkQueue().catch((err) => console.warn(LOG, err)), delay);
	}

	function uriOf(track) {
		return track?.contextTrack?.uri ?? track?.uri;
	}

	function contextEntry(uri) {
		return { contextTrack: { uri, uid: "", metadata: { is_queued: "false" } }, removed: [], blocked: [], provider: "context" };
	}

	// Maps a queue entry to the album's track URI (handles relinked tracks).
	function albumUriOf(track, known) {
		const uri = uriOf(track);
		if (known.has(uri)) return uri;
		const requested = track?.contextTrack?.metadata?.requested_uri ?? track?.metadata?.requested_uri;
		return requested && known.has(requested) ? requested : uri;
	}

	function indexOfItem(order, item, tracks, albumUri) {
		const known = new Set(order);
		const index = order.indexOf(albumUriOf(item, known));
		if (index >= 0) return index;
		const meta = item.metadata ?? {};
		if (meta.album_uri === albumUri && meta.album_track_number) {
			const number = Number(meta.album_track_number);
			const disc = Number(meta.album_disc_number || 1);
			const track = tracks.find((t) => t.number === number && t.disc === disc);
			if (track) return order.indexOf(track.uri);
		}
		return -1;
	}

	function readQueue() {
		return playerApi._queue?._queue ?? Spicetify.Queue ?? null;
	}

	async function writeQueue(queue, nextTracks) {
		const client = playerApi._queue?._client;
		if (typeof client?.setQueue === "function") {
			return client.setQueue({ nextTracks, prevTracks: queue.prevTracks ?? [], queueRevision: queue.queueRevision });
		}
		// Older Spotify builds: the player's queue endpoint.
		if (typeof Spicetify.CosmosAsync?.put !== "function") return;
		const plain = (t) => ({ uri: uriOf(t), uid: t.contextTrack?.uid ?? t.uid ?? "", provider: t.provider, metadata: t.contextTrack?.metadata ?? t.metadata ?? {} });
		return Spicetify.CosmosAsync.put("sp://player/v2/main/queue", {
			queue_revision: queue.queueRevision,
			next_tracks: nextTracks.map(plain),
			prev_tracks: (queue.prevTracks ?? []).map(plain),
		});
	}

	async function checkQueue() {
		if (Date.now() > fixWindowUntil) {
			resetOverride = null;
			return;
		}
		let state = playerApi.getState?.();
		const albumUri = state?.context?.uri;
		const entry = getEntry(albumUri);
		const override = !entry && resetOverride?.albumUri === albumUri ? resetOverride : null;
		if ((!entry && !override) || state.shuffle || state.smartShuffle || !state.item) return;

		const tracks = await getAlbumTracks(albumUri).catch(() => null);
		state = playerApi.getState();
		if (!tracks || state?.context?.uri !== albumUri || !state.item || state.item.provider === "queue") return;

		const original = tracks.map((t) => t.uri);
		const order = reconcile((entry ?? override).order, original);
		const known = new Set(order);
		const index = indexOfItem(order, state.item, tracks, albumUri);
		if (index < 0) return;

		const queue = readQueue();
		if (!Array.isArray(queue?.nextTracks)) return;
		if (queue.track && albumUriOf(queue.track, known) !== order[index]) {
			// The queue hasn't caught up with the player yet.
			scheduleCheck(300);
			return;
		}

		const playable = new Set(tracks.filter((t) => t.playable).map((t) => t.uri));
		const repeating = state.repeat === 1;
		let desired = order.slice(index + 1);
		if (repeating) desired = desired.concat(order.slice(0, index + 1));
		desired = desired.filter((uri) => playable.has(uri));
		// "complete": everything left of the album fits in what we hand Spotify.
		const complete = !repeating && desired.length <= QUEUE_WINDOW;

		const next = queue.nextTracks;
		const actual = next.filter((t) => t.provider === "context" && uriOf(t) !== DELIMITER).map((t) => albumUriOf(t, known));
		if (complete ? arraysEqual(actual, desired) : startsWith(actual, desired.slice(0, QUEUE_CHECK))) {
			if (override) resetOverride = null;
			return;
		}

		const attemptKey = `${fixWindowId}|${state.item.uid || state.item.uri}`;
		const attempts = fixAttempts.get(attemptKey) ?? 0;
		if (attempts >= 4) return;
		fixAttempts.set(attemptKey, attempts + 1);

		const existing = new Map();
		for (const t of next) if (t?.provider === "context") existing.set(albumUriOf(t, known), t);
		// New entries get an empty uid so Spotify assigns one: it silently drops entries whose uid
		// it doesn't expect (e.g. the album's own uid for a track outside the part it has loaded).
		const contextTracks = desired.slice(0, QUEUE_WINDOW).map((uri) => existing.get(uri) ?? contextEntry(uri));
		const queued = next.filter((t) => t.provider === "queue");
		const others = next.filter((t) => t.provider !== "queue" && t.provider !== "context" && uriOf(t) !== DELIMITER);
		// After the album's last track, let autoplay (or whatever Spotify lined up) follow. If Spotify
		// went on with the album in its original order after our list, stop it with a delimiter.
		let tail = [];
		if (complete) {
			const ranOn = actual.length > desired.length && startsWith(actual, desired);
			tail = others.length ? others : ranOn ? [contextEntry(DELIMITER)] : [];
		}
		await writeQueue(queue, [...queued, ...contextTracks, ...tail]);
	}

	let last = {};
	function onPlayerUpdate() {
		const state = playerApi.getState?.();
		if (!state) return;
		const context = state.context?.uri ?? null;
		const item = state.item?.uid || state.item?.uri || null;
		if (getEntry(context) || resetOverride?.albumUri === context) {
			if (context !== last.context || (last.shuffle && !state.shuffle) || last.repeat !== state.repeat) openFixWindow();
			else if (item !== last.item) openFixWindow(4000);
		}
		last = { context, shuffle: state.shuffle, repeat: state.repeat, item };
		if (Date.now() < fixWindowUntil) scheduleCheck();
	}

	const emitters = new Set([playerApi.getEvents?.() ?? playerApi._events, playerApi._queue?._events].filter(Boolean));
	for (const emitter of emitters) {
		const target = typeof emitter.addListener === "function" ? emitter : emitter._emitter;
		target?.addListener?.("update", onPlayerUpdate);
		target?.addListener?.("queue_update", () => {
			if (Date.now() < fixWindowUntil) scheduleCheck();
		});
	}
	// Older builds: Spicetify's own player events.
	Spicetify.Player?.addEventListener?.("songchange", onPlayerUpdate);
	onPlayerUpdate();
})();
