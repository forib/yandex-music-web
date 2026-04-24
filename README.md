# Yandex Music Web

> **⚠️ Early development** — the app is functional but some features may be incomplete or broken. Report issues on the [Issues](https://github.com/forib/yandex-music-web/issues) page.

🌐 **Live web app:** [yandex-music-web.vercel.app](https://yandex-music-web.vercel.app)
💾 **Desktop app (Windows):** see [Releases](https://github.com/forib/yandex-music-web/releases)

---

[English](#english) | [Русский](#русский)

---

## English

Browser-based Yandex Music downloader library. Use this library in your projects to download tracks with metadata and album artwork.

## Installation

```html
<script src="yandex-api.js"></script>
<script src="downloader.js"></script>
```

Or use as ES modules:

```javascript
import * as yandexApi from './yandex-api.js';
import * as downloader from './downloader.js';
```

**Note:** Requires server with `/api/*` endpoints (see `server.js` for reference implementation).

---

## API Reference

### Yandex API (`yandex-api.js`)

#### `parseYandexUrl(url)`
Parse Yandex Music URL to structured object.

```javascript
const parsed = parseYandexUrl('https://music.yandex.ru/album/123/track/456');
// { type: 'track', albumId: '123', trackId: '456' }
```

**Supported URL types:**
- Track: `/track/123`
- Album track: `/album/123/track/456`
- Album: `/album/123`
- Artist: `/artist/123`
- Playlist: `/users/username/playlists/123`

Returns `null` for invalid URLs.

---

#### `resolveTracklist(parsed, token, onStatus)`
Resolve parsed URL to array of track objects.

```javascript
const parsed = parseYandexUrl('https://music.yandex.ru/users/user/playlists/123');
const tracks = await resolveTracklist(parsed, token, status => console.log(status));
```

`onStatus` - optional callback for progress messages.

---

#### `getTrack(trackId, token)`
Get track metadata from API.

```javascript
const track = await getTrack('123456789', token);
console.log(track.title, track.artists);
```

---

#### `getTrackDownloadInfo(trackId, token, qualityLevel)`
Get download URL for a track.

```javascript
const info = await getTrackDownloadInfo('123456789', token, 2);
// { container: 'flac', codec: 'flac', quality: 'lossless', urls: [...], bitrate: 0 }
```

`qualityLevel`: 0 = low (64kbps), 1 = high (192kbps), 2 = lossless (FLAC)

---

#### `getAlbumWithTracks(albumId, token)`
Get album with all tracks.

```javascript
const album = await getAlbumWithTracks('123', token);
const tracks = album.volumes.flat();
```

---

#### `getArtistAlbums(artistId, token, page)`
Get albums by artist (paginated).

```javascript
const info = await getArtistAlbums('123', token, 0);
const albums = info.albums;
```

---

#### `getUserPlaylist(owner, kind, token)`
Get user playlist.

```javascript
const playlist = await getUserPlaylist('username', 123, token);
const tracks = playlist.tracks;
```

---

#### `getTracksById(trackIds, token)`
Get multiple tracks by IDs.

```javascript
const tracks = await getTracksById(['id1', 'id2', 'id3'], token);
```

---

#### `getLyrics(trackId, token)`
Get track lyrics.

```javascript
const lyrics = await getLyrics('123456789', token);
// Returns null if not available
```

---

### Downloader (`downloader.js`)

#### `downloadTrack(track, token, quality, opts, onStatus)`
Download single track with metadata.

```javascript
const result = await downloadTrack(track, token, 2, {
  embedCover: true,
  fetchLyrics: true
}, status => console.log(status));

// result = { bytes: Uint8Array, filename: '01 - Title.flac' }
```

`opts`:
- `embedCover` (default: true) - Embed album cover
- `fetchLyrics` (default: false) - Fetch and embed lyrics

`quality`: 0 = low, 1 = high, 2 = lossless

---

#### `saveFile(bytes, filename)`
Save file to disk.

```javascript
await saveFile(result.bytes, result.filename);
```

- **Chrome/Edge**: Shows folder picker, then saves directly
- **Firefox/Safari**: Triggers browser download dialog

---

#### `saveAsZip(items, zipName)`
Save multiple files as ZIP.

```javascript
const items = await Promise.all(tracks.map(t => downloadTrack(t, token, 2)));
await saveAsZip(items, 'album.zip');
```

---

#### `extractMeta(track)`
Extract metadata from API track object.

```javascript
const meta = extractMeta(track);
// { title, album, artists, albumArtists, date, trackNumber, discNumber, genre, coverUri, url }
```

---

#### `buildFilename(track, container)`
Generate filename from track.

```javascript
const filename = buildFilename(track, 'flac');
// '01 - Song Title.flac'
```

---

### Authentication

Get OAuth token:
1. Open [music.yandex.ru](https://music.yandex.ru)
2. Developer Tools (F12) → Network tab
3. Find request to `api.music.yandex.net`
4. Copy `Authorization` header (starts with `OAuth `)

Pass token to all API calls:

```javascript
const token = 'your-oauth-token';
const track = await getTrack('123', token);
```

---

## Usage Examples

### Download Single Track

```javascript
const token = 'OAuth ...';

const parsed = parseYandexUrl('https://music.yandex.ru/track/123456789');
const tracks = await resolveTracklist(parsed, token);

const result = await downloadTrack(tracks[0], token, 2);
await saveFile(result.bytes, result.filename);
```

### Download Album

```javascript
const parsed = parseYandexUrl('https://music.yandex.ru/album/123');
const tracks = await resolveTracklist(parsed, token);

const items = await Promise.all(
  tracks.map(t => downloadTrack(t, token, 2))
);
await saveAsZip(items, 'Album Name.zip');
```

### Download Playlist

```javascript
const parsed = parseYandexUrl('https://music.yandex.ru/users/user/playlists/123');
const tracks = await resolveTracklist(parsed, token);

// Filter available tracks only
const available = tracks.filter(t => t.available !== false);

for (const track of available) {
  const result = await downloadTrack(track, token, 2);
  await saveFile(result.bytes, result.filename);
}
```

### Custom Metadata Handling

```javascript
const meta = extractMeta(track);

console.log(meta.title);       // Track title (with version if exists)
console.log(meta.album);       // Album name
console.log(meta.artists);      // ['Artist1', 'Artist2']
console.log(meta.trackNumber); // 5
console.log(meta.date);       // '2024-01-15'
console.log(meta.coverUri);  // 'avatars辽大00/%%/yandexMusic' - use '%%' replacement for size
```

---

## Русский

Браузерная библиотека для загрузки Яндекс.Музыки. Используйте в своих проектах для скачивания треков с метаданными и обложками.

## Установка

```html
<script src="yandex-api.js"></script>
<script src="downloader.js"></script>
```

Или как ES-модули:

```javascript
import * as yandexApi from './yandex-api.js';
import * as downloader from './downloader.js';
```

**Важно:** Требуется сервер с `/api/*` эндпоинтами (см. `server.js` для примера).

---

## Справочник API

### Yandex API (`yandex-api.js`)

#### `parseYandexUrl(url)`
Парсинг URL Яндекс.Музыки в структурированный объект.

```javascript
const parsed = parseYandexUrl('https://music.yandex.ru/album/123/track/456');
// { type: 'track', albumId: '123', trackId: '456' }
```

**Поддерживаемые типы URL:**
- Трек: `/track/123`
- Трек альбома: `/album/123/track/456`
- Альбом: `/album/123`
- Исполнитель: `/artist/123`
- Плейлист: `/users/username/playlists/123`

Возвращает `null` для неверных URL.

---

#### `resolveTracklist(parsed, token, onStatus)`
Разрешение URL в массив объектов треко��.

```javascript
const parsed = parseYandexUrl('https://music.yandex.ru/users/user/playlists/123');
const tracks = await resolveTracklist(parsed, token, status => console.log(status));
```

`onStatus` - опциональный коллбэк для сообщений о прогрессе.

---

#### `getTrack(trackId, token)`
Получение метаданных трека из API.

```javascript
const track = await getTrack('123456789', token);
console.log(track.title, track.artists);
```

---

#### `getTrackDownloadInfo(trackId, token, qualityLevel)`
Получение URL для скачивания трека.

```javascript
const info = await getTrackDownloadInfo('123456789', token, 2);
// { container: 'flac', codec: 'flac', quality: 'lossless', urls: [...], bitrate: 0 }
```

`qualityLevel`: 0 = low (64kbps), 1 = high (192kbps), 2 = lossless (FLAC)

---

#### `getAlbumWithTracks(albumId, token)`
Получение альбома со всеми треками.

```javascript
const album = await getAlbumWithTracks('123', token);
const tracks = album.volumes.flat();
```

---

#### `getArtistAlbums(artistId, token, page)`
Получение альбомов исполнителя (постранично).

```javascript
const info = await getArtistAlbums('123', token, 0);
const albums = info.albums;
```

---

#### `getUserPlaylist(owner, kind, token)`
Получение плейлиста пользователя.

```javascript
const playlist = await getUserPlaylist('username', 123, token);
const tracks = playlist.tracks;
```

---

#### `getTracksById(trackIds, token)`
Получение нескольких треков по ID.

```javascript
const tracks = await getTracksById(['id1', 'id2', 'id3'], token);
```

---

#### `getLyrics(trackId, token)`
Получение текста песни.

```javascript
const lyrics = await getLyrics('123456789', token);
// Возвращает null, если недоступно
```

---

### Загрузчик (`downloader.js`)

#### `downloadTrack(track, token, quality, opts, onStatus)`
Загрузка трека с метаданными.

```javascript
const result = await downloadTrack(track, token, 2, {
  embedCover: true,
  fetchLyrics: true
}, status => console.log(status));

// result = { bytes: Uint8Array, filename: '01 - Title.flac' }
```

`opts`:
- `embedCover` (по умолчанию: true) - Вставить обложку
- `fetchLyrics` (по умолчанию: false) - Получить и вставить текст

`quality`: 0 = low, 1 = high, 2 = lossless

---

#### `saveFile(bytes, filename)`
Сохранение файла на диск.

```javascript
await saveFile(result.bytes, result.filename);
```

- **Chrome/Edge**: Показывает выбор папки, затем сохраняет напрямую
- **Firefox/Safari**: Запускает диалог загрузки браузера

---

#### `saveAsZip(items, zipName)`
Сохранение нескольких файлов как ZIP.

```javascript
const items = await Promise.all(tracks.map(t => downloadTrack(t, token, 2)));
await saveAsZip(items, 'album.zip');
```

---

#### `extractMeta(track)`
Извлечение метаданных из объекта трека API.

```javascript
const meta = extractMeta(track);
// { title, album, artists, albumArtists, date, trackNumber, discNumber, genre, coverUri, url }
```

---

#### `buildFilename(track, container)`
Генерация имени файла из трека.

```javascript
const filename = buildFilename(track, 'flac');
// '01 - Song Title.flac'
```

---

### Аутентификация

Получение OAuth-токена:
1. Откройте [music.yandex.ru](https://music.yandex.ru)
2. Инструменты р��зр��ботчика (F12) → вкладка Network
3. Найдите любой запрос к `api.music.yandex.net`
4. Скопируйте заголовок `Authorization` (начинается с `OAuth `)

Передавайте токен во все вызовы API:

```javascript
const token = 'your-oauth-token';
const track = await getTrack('123', token);
```

---

## Примеры использования

### Скачивание одного трека

```javascript
const token = 'OAuth ...';

const parsed = parseYandexUrl('https://music.yandex.ru/track/123456789');
const tracks = await resolveTracklist(parsed, token);

const result = await downloadTrack(tracks[0], token, 2);
await saveFile(result.bytes, result.filename);
```

### Скачивание альбома

```javascript
const parsed = parseYandexUrl('https://music.yandex.ru/album/123');
const tracks = await resolveTracklist(parsed, token);

const items = await Promise.all(
  tracks.map(t => downloadTrack(t, token, 2))
);
await saveAsZip(items, 'Album Name.zip');
```

### Скачивание плейлиста

```javascript
const parsed = parseYandexUrl('https://music.yandex.ru/users/user/playlists/123');
const tracks = await resolveTracklist(parsed, token);

// Фильтр доступных треков
const available = tracks.filter(t => t.available !== false);

for (const track of available) {
  const result = await downloadTrack(track, token, 2);
  await saveFile(result.bytes, result.filename);
}
```

### Собственная обработка метаданных

```javascript
const meta = extractMeta(track);

console.log(meta.title);       // Название трека (с версией, если есть)
console.log(meta.album);    // Название альбома
console.log(meta.artists); // ['Исполнитель1', 'Исполнитель2']
console.log(meta.trackNumber); // 5
console.log(meta.date);    // '2024-01-15'
console.log(meta.coverUri); // 'avatars辽大00/%%/yandexMusic' - замените '%%' на размер
```