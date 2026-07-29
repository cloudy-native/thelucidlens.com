#!/usr/bin/env node
/**
 * Import a local portfolio directory into Astro content collections.
 *
 * Expected layout (matches /Volumes/Recordings/portfolio):
 *
 *   portfolio/
 *     city/                  → subject slug "city"
 *       _subject.yml         → optional subject overrides
 *       IMG_1493.jpg
 *       IMG_1493.yml         → optional photo overrides (caption, title, …)
 *     coast/
 *       …
 *
 * Images stay on the drive (and in S3/CloudFront). Only lightweight .md
 * files are written into the git repo. Image URLs include a content-hash
 * query (`?v=…`) so browsers do not keep serving replaced files under the
 * same object key (CDN still ignores the query; see photo CachePolicy).
 *
 * Usage:
 *   node scripts/import-portfolio.mjs \
 *     --source /Volumes/Recordings/portfolio \
 *     --base-url https://photos.thelucidlens.com
 *
 * Options:
 *   --source <dir>       Portfolio root (required unless PORTFOLIO_SOURCE set)
 *   --base-url <url>     CDN origin for images (required unless PHOTO_BASE_URL set)
 *   --out <dir>          Website root (default: repo root)
 *   --clean              Remove generated photo/subject md not present in source
 *   --write-sidecars     Write missing .yml sidecars next to images on the drive
 *   --dry-run            Print actions without writing
 *   --subject <slug>     Import only one subject folder
 *   --help
 *
 * Content .md under src/content is treated as generated output. Hand-edit
 * titles/captions on the drive (sidecars) and re-run this script.
 */

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from 'node:fs';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.tif', '.tiff', '.heic', '.avif']);
const SUBJECT_META = new Set(['_subject.yml', '_subject.yaml', '_subject.json']);
const SKIP_NAMES = new Set(['.ds_store', 'thumbs.db', '.gitkeep']);

// ─── CLI ────────────────────────────────────────────────────────────────────

function printHelp() {
	console.log(`Usage: node scripts/import-portfolio.mjs [options]

Required:
  --source <dir>     Local portfolio root (subject folders of images)
  --base-url <url>   Public CDN base (CloudFront), no trailing slash

Optional:
  --out <dir>        Website root (default: ${REPO_ROOT})
  --clean            Delete content md files not regenerated this run
  --write-sidecars   Create empty-ish .yml sidecars on the drive for editing
  --dry-run          Show what would be written
  --subject <slug>   Only import one subject folder
  --help             Show this help

Env:
  PORTFOLIO_SOURCE   Same as --source
  PHOTO_BASE_URL     Same as --base-url
`);
}

function parseArgs(argv) {
	const opts = {
		source: process.env.PORTFOLIO_SOURCE || '',
		baseUrl: process.env.PHOTO_BASE_URL || '',
		out: REPO_ROOT,
		clean: false,
		writeSidecars: false,
		dryRun: false,
		subject: null,
		help: false,
	};

	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		const next = () => {
			const v = argv[++i];
			if (v == null || v.startsWith('--')) throw new Error(`Missing value for ${a}`);
			return v;
		};
		switch (a) {
			case '--source':
				opts.source = next();
				break;
			case '--base-url':
				opts.baseUrl = next();
				break;
			case '--out':
				opts.out = next();
				break;
			case '--clean':
				opts.clean = true;
				break;
			case '--write-sidecars':
				opts.writeSidecars = true;
				break;
			case '--dry-run':
				opts.dryRun = true;
				break;
			case '--force':
				// Accepted for backwards compatibility; content md is always regenerated.
				break;
			case '--subject':
				opts.subject = next();
				break;
			case '--help':
			case '-h':
				opts.help = true;
				break;
			default:
				throw new Error(`Unknown argument: ${a}`);
		}
	}
	return opts;
}

// ─── tiny YAML (subset) ─────────────────────────────────────────────────────
// Enough for our sidecars and frontmatter — avoids extra dependencies.

function parseSimpleYaml(text) {
	/** @type {Record<string, unknown>} */
	const out = {};
	/** @type {string | null} */
	let cameraKey = null;
	/** @type {Record<string, unknown> | null} */
	let camera = null;

	const lines = text.split(/\r?\n/);
	for (const raw of lines) {
		const line = raw.replace(/\t/g, '  ');
		if (!line.trim() || line.trim().startsWith('#')) continue;

		const cameraChild = line.match(/^  ([A-Za-z][\w]*)\s*:\s*(.*)$/);
		if (cameraKey && cameraChild) {
			const [, k, v] = cameraChild;
			camera[k] = coerceYamlScalar(v);
			continue;
		}
		cameraKey = null;
		camera = null;

		const m = line.match(/^([A-Za-z][\w]*)\s*:\s*(.*)$/);
		if (!m) continue;
		const [, key, rest] = m;
		if (rest === '' || rest === '|' || rest === '>') {
			// nested object start (camera:) or empty
			if (key === 'camera') {
				cameraKey = key;
				camera = {};
				out.camera = camera;
			} else {
				out[key] = '';
			}
			continue;
		}
		out[key] = coerceYamlScalar(rest);
	}
	return out;
}

function coerceYamlScalar(v) {
	const s = v.trim();
	if (
		(s.startsWith('"') && s.endsWith('"')) ||
		(s.startsWith("'") && s.endsWith("'"))
	) {
		return s.slice(1, -1);
	}
	if (s === 'true') return true;
	if (s === 'false') return false;
	if (s === 'null' || s === '~' || s === '') return null;
	if (/^-?\d+$/.test(s)) return Number(s);
	if (/^-?\d+\.\d+$/.test(s)) return Number(s);
	return s;
}

function yamlQuote(value) {
	if (value == null) return '""';
	const s = String(value);
	if (s === '') return '""';
	if (/^[\w./:@+-]+$/.test(s) && !/^(true|false|null|yes|no)$/i.test(s)) {
		return s;
	}
	return JSON.stringify(s);
}

/**
 * @param {Record<string, unknown>} data
 */
function toFrontmatter(data) {
	const lines = ['---'];
	for (const [key, value] of Object.entries(data)) {
		if (value == null || value === '') continue;
		if (key === 'camera' && typeof value === 'object') {
			const cam = /** @type {Record<string, unknown>} */ (value);
			const entries = Object.entries(cam).filter(([, v]) => v != null && v !== '');
			if (!entries.length) continue;
			lines.push('camera:');
			for (const [ck, cv] of entries) {
				lines.push(`  ${ck}: ${yamlQuote(cv)}`);
			}
			continue;
		}
		lines.push(`${key}: ${yamlQuote(value)}`);
	}
	lines.push('---', '');
	return lines.join('\n');
}

// ─── filesystem helpers ─────────────────────────────────────────────────────

function listSubjectDirs(sourceRoot, onlySubject) {
	return readdirSync(sourceRoot, { withFileTypes: true })
		.filter((d) => d.isDirectory() && !d.name.startsWith('.'))
		.map((d) => d.name)
		.filter((name) => (onlySubject ? name === onlySubject : true))
		.sort((a, b) => a.localeCompare(b));
}

function listImages(dir) {
	return readdirSync(dir, { withFileTypes: true })
		.filter((d) => d.isFile())
		.map((d) => d.name)
		.filter((name) => {
			const lower = name.toLowerCase();
			if (SKIP_NAMES.has(lower)) return false;
			if (SUBJECT_META.has(lower)) return false;
			if (lower.endsWith('.yml') || lower.endsWith('.yaml') || lower.endsWith('.json')) return false;
			return IMAGE_EXTS.has(extname(lower));
		})
		.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
}

function slugify(input) {
	return String(input)
		.normalize('NFKD')
		.replace(/[\u0300-\u036f]/g, '')
		.replace(/\+/g, '-')
		.replace(/[^a-zA-Z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.toLowerCase()
		.slice(0, 80) || 'photo';
}

function titleFromFilename(filename) {
	const stem = basename(filename, extname(filename));
	return stem
		.replace(/[_-]+/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

/** True when a string is just a camera/export filename, not a human title. */
function looksLikeFilename(value) {
	if (!value || !String(value).trim()) return true;
	const t = String(value).trim();
	if (/^(?:_?DSC(?:N|F)?|IMG|P\d{3,}|fullsizeoutput)[\s_-]*/i.test(t)) return true;
	if (/^[0-9a-f]{8}(?:-?[0-9a-f]{4}){3}-?[0-9a-f]{12}$/i.test(t.replace(/\s/g, ''))) return true;
	if (/^\d{8,}(?:__|-)/.test(t.replace(/\s/g, ''))) return true;
	if (/^[A-Za-z0-9+_-]{16,}$/.test(t.replace(/\s/g, ''))) return true;
	return false;
}

function readSidecar(imagePath) {
	const stem = imagePath.slice(0, -extname(imagePath).length);
	for (const ext of ['.yml', '.yaml', '.json']) {
		const p = stem + ext;
		if (!existsSync(p)) continue;
		const text = readFileSync(p, 'utf8');
		if (ext === '.json') return JSON.parse(text);
		return parseSimpleYaml(text);
	}
	return {};
}

function readSubjectMeta(subjectDir) {
	for (const name of ['_subject.yml', '_subject.yaml']) {
		const p = join(subjectDir, name);
		if (!existsSync(p)) continue;
		return parseSimpleYaml(readFileSync(p, 'utf8'));
	}
	const jsonPath = join(subjectDir, '_subject.json');
	if (existsSync(jsonPath)) {
		return JSON.parse(readFileSync(jsonPath, 'utf8'));
	}
	return {};
}

function writeGenerated(path, content, { dryRun }) {
	if (existsSync(path) && readFileSync(path, 'utf8') === content) {
		return 'unchanged';
	}
	if (dryRun) {
		return 'would-write';
	}
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content, 'utf8');
	return 'wrote';
}

// ─── metadata extraction ────────────────────────────────────────────────────

/**
 * Prefer ImageMagick for EXIF; fall back to sips + mdls on macOS.
 * @param {string} imagePath
 */
function extractMetadata(imagePath) {
	const fromMagick = extractViaMagick(imagePath);
	const fromMdls = extractViaMdls(imagePath);
	const fromSips = extractViaSips(imagePath);

	const width = fromMagick.width ?? fromSips.width ?? fromMdls.width;
	const height = fromMagick.height ?? fromSips.height ?? fromMdls.height;

	const body =
		formatBody(fromMagick.make, fromMagick.model) ||
		formatBody(fromMdls.make, fromMdls.model) ||
		undefined;

	const aperture = formatAperture(fromMagick.fNumber ?? fromMdls.fNumber);
	const shutter = formatShutter(fromMagick.exposure ?? fromMdls.exposure);
	const iso = fromMagick.iso ?? fromMdls.iso;
	// Prefer 35mm-equivalent focal length when Spotlight provides it (phones).
	const focalLength = formatFocal(
		fromMdls.focal35 ?? fromMagick.focalLength ?? fromMdls.focalLength,
	);
	const lens = fromMagick.lens || fromMdls.lens;

	/** @type {Record<string, string | number>} */
	const camera = {};
	if (body) camera.body = body;
	if (lens) camera.lens = lens;
	if (aperture) camera.aperture = aperture;
	if (shutter) camera.shutter = shutter;
	if (iso != null) camera.iso = iso;
	if (focalLength) camera.focalLength = focalLength;

	const date = fromMagick.date || fromMdls.date;
	const location = fromMdls.location || formatGps(fromMagick.gps || fromMdls.gps);

	return {
		width,
		height,
		date,
		location,
		camera: Object.keys(camera).length ? camera : undefined,
		title: fromMagick.title || fromMdls.title,
		caption: fromMagick.caption || fromMdls.caption,
	};
}

function extractViaMagick(imagePath) {
	if (!commandExists('magick')) return {};
	const format = [
		'width=%w',
		'height=%h',
		'make=%[EXIF:Make]',
		'model=%[EXIF:Model]',
		'datetime=%[EXIF:DateTimeOriginal]',
		'fnumber=%[EXIF:FNumber]',
		'exposure=%[EXIF:ExposureTime]',
		'iso=%[EXIF:PhotographicSensitivity]',
		'iso2=%[EXIF:ISOSpeedRatings]',
		'focal=%[EXIF:FocalLength]',
		'lens=%[EXIF:LensModel]',
		'imageDesc=%[EXIF:ImageDescription]',
		'artist=%[EXIF:Artist]',
		'gpsLat=%[EXIF:GPSLatitude]',
		'gpsLatRef=%[EXIF:GPSLatitudeRef]',
		'gpsLon=%[EXIF:GPSLongitude]',
		'gpsLonRef=%[EXIF:GPSLongitudeRef]',
	].join('\n');

	const r = spawnSync('magick', ['identify', '-format', format, imagePath], {
		encoding: 'utf8',
		maxBuffer: 2 * 1024 * 1024,
	});
	if (r.status !== 0) return {};

	/** @type {Record<string, string>} */
	const map = {};
	for (const line of r.stdout.split('\n')) {
		const i = line.indexOf('=');
		if (i === -1) continue;
		const k = line.slice(0, i);
		const v = line.slice(i + 1).trim();
		if (v && !v.startsWith('%[')) map[k] = v;
	}

	const isoRaw = map.iso || map.iso2;
	return {
		width: map.width ? Number(map.width) : undefined,
		height: map.height ? Number(map.height) : undefined,
		make: cleanMake(map.make),
		model: map.model,
		date: parseExifDate(map.datetime),
		fNumber: parseRational(map.fnumber),
		exposure: parseRational(map.exposure),
		iso: isoRaw ? Number(String(isoRaw).split(' ')[0]) : undefined,
		focalLength: parseRational(map.focal),
		lens: map.lens,
		title: map.imageDesc && map.imageDesc.length < 80 ? map.imageDesc : undefined,
		caption: map.imageDesc && map.imageDesc.length >= 80 ? map.imageDesc : undefined,
		gps: parseExifGps(map.gpsLat, map.gpsLatRef, map.gpsLon, map.gpsLonRef),
	};
}

function extractViaSips(imagePath) {
	if (!commandExists('sips')) return {};
	const r = spawnSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', imagePath], {
		encoding: 'utf8',
	});
	if (r.status !== 0) return {};
	const width = Number((r.stdout.match(/pixelWidth:\s*(\d+)/) || [])[1]);
	const height = Number((r.stdout.match(/pixelHeight:\s*(\d+)/) || [])[1]);
	return {
		width: Number.isFinite(width) ? width : undefined,
		height: Number.isFinite(height) ? height : undefined,
	};
}

function extractViaMdls(imagePath) {
	if (!commandExists('mdls')) return {};
	const keys = [
		'kMDItemPixelWidth',
		'kMDItemPixelHeight',
		'kMDItemAcquisitionMake',
		'kMDItemAcquisitionModel',
		'kMDItemLensModel',
		'kMDItemFNumber',
		'kMDItemExposureTimeSeconds',
		'kMDItemISOSpeed',
		'kMDItemFocalLength',
		'kMDItemFocalLength35mm',
		'kMDItemContentCreationDate',
		'kMDItemLatitude',
		'kMDItemLongitude',
		'kMDItemCity',
		'kMDItemStateOrProvince',
		'kMDItemCountry',
		'kMDItemTitle',
		'kMDItemDescription',
	];
	const r = spawnSync('mdls', [...keys.flatMap((k) => ['-name', k]), imagePath], {
		encoding: 'utf8',
	});
	if (r.status !== 0) return {};

	/** @type {Record<string, string>} */
	const map = {};
	for (const line of r.stdout.split('\n')) {
		const m = line.match(/^(kMDItem\w+)\s*=\s*(.*)$/);
		if (!m) continue;
		let v = m[2].trim();
		if (v === '(null)') continue;
		if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
		map[m[1]] = v;
	}

	const parts = [map.kMDItemCity, map.kMDItemStateOrProvince, map.kMDItemCountry].filter(Boolean);
	const location = parts.length ? parts.join(', ') : undefined;

	let gps;
	if (map.kMDItemLatitude && map.kMDItemLongitude) {
		gps = { lat: Number(map.kMDItemLatitude), lon: Number(map.kMDItemLongitude) };
	}

	return {
		width: map.kMDItemPixelWidth ? Number(map.kMDItemPixelWidth) : undefined,
		height: map.kMDItemPixelHeight ? Number(map.kMDItemPixelHeight) : undefined,
		make: cleanMake(map.kMDItemAcquisitionMake),
		model: map.kMDItemAcquisitionModel,
		lens: map.kMDItemLensModel,
		fNumber: map.kMDItemFNumber ? Number(map.kMDItemFNumber) : undefined,
		exposure: map.kMDItemExposureTimeSeconds
			? Number(map.kMDItemExposureTimeSeconds)
			: undefined,
		iso: map.kMDItemISOSpeed ? Number(map.kMDItemISOSpeed) : undefined,
		focalLength: map.kMDItemFocalLength ? Number(map.kMDItemFocalLength) : undefined,
		focal35: map.kMDItemFocalLength35mm ? Number(map.kMDItemFocalLength35mm) : undefined,
		date: parseMdlsDate(map.kMDItemContentCreationDate),
		location,
		gps,
		title: map.kMDItemTitle,
		caption: map.kMDItemDescription,
	};
}

function commandExists(cmd) {
	const r = spawnSync('which', [cmd], { encoding: 'utf8' });
	return r.status === 0;
}

function cleanMake(make) {
	if (!make) return undefined;
	return make.replace(/\s*CORPORATION\s*/i, ' ').replace(/\s+/g, ' ').trim();
}

function formatBody(make, model) {
	const m = cleanMake(make);
	const mod = model?.trim();
	if (!m && !mod) return undefined;
	if (!m) return mod;
	if (!mod) return m;
	// Avoid "NIKON NIKON Z 7" when model already includes the make.
	if (mod.toLowerCase().startsWith(m.toLowerCase())) return mod;
	return `${m} ${mod}`;
}

function parseRational(v) {
	if (v == null || v === '') return undefined;
	if (typeof v === 'number') return v;
	const s = String(v).trim();
	if (s.includes('/')) {
		const [a, b] = s.split('/').map(Number);
		if (b) return a / b;
	}
	const n = Number(s);
	return Number.isFinite(n) ? n : undefined;
}

/**
 * Parse EXIF GPS DMS (e.g. "16/1,458020200/10000000,0/1" + "N") into signed decimal degrees.
 * @param {string | undefined} latRaw
 * @param {string | undefined} latRef
 * @param {string | undefined} lonRaw
 * @param {string | undefined} lonRef
 * @returns {{ lat: number, lon: number } | undefined}
 */
function parseExifGps(latRaw, latRef, lonRaw, lonRef) {
	const lat = parseExifDms(latRaw);
	const lon = parseExifDms(lonRaw);
	if (lat == null || lon == null) return undefined;
	const latSign = String(latRef || 'N').toUpperCase().startsWith('S') ? -1 : 1;
	const lonSign = String(lonRef || 'E').toUpperCase().startsWith('W') ? -1 : 1;
	return { lat: lat * latSign, lon: lon * lonSign };
}

/** @param {string | undefined} dms */
function parseExifDms(dms) {
	if (!dms) return undefined;
	const parts = String(dms)
		.split(',')
		.map((p) => parseRational(p.trim()))
		.filter((n) => n != null);
	if (!parts.length) return undefined;
	const [deg = 0, min = 0, sec = 0] = parts;
	const value = deg + min / 60 + sec / 3600;
	return Number.isFinite(value) ? value : undefined;
}

function parseExifDate(v) {
	if (!v) return undefined;
	// "2019:07:03 19:25:19"
	const m = String(v).match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
	if (!m) return undefined;
	const [, Y, Mo, D] = m;
	return `${Y}-${Mo}-${D}`;
}

function parseMdlsDate(v) {
	if (!v) return undefined;
	// "2019-07-03 12:25:19 +0000"
	const m = String(v).match(/^(\d{4}-\d{2}-\d{2})/);
	return m ? m[1] : undefined;
}

function formatAperture(n) {
	if (n == null || !Number.isFinite(n)) return undefined;
	const rounded = Math.round(n * 10) / 10;
	return `f/${rounded % 1 === 0 ? String(rounded.toFixed(0)) : String(rounded)}`;
}

function formatShutter(seconds) {
	if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return undefined;
	if (seconds >= 1) {
		const r = Math.round(seconds * 10) / 10;
		return `${r % 1 === 0 ? r.toFixed(0) : r}s`;
	}
	const denom = Math.round(1 / seconds);
	return `1/${denom}s`;
}

function formatFocal(mm) {
	if (mm == null || !Number.isFinite(mm)) return undefined;
	const r = Math.round(mm);
	return `${r}mm`;
}

function formatGps(gps) {
	if (!gps || !Number.isFinite(gps.lat) || !Number.isFinite(gps.lon)) return undefined;
	const ns = gps.lat >= 0 ? 'N' : 'S';
	const ew = gps.lon >= 0 ? 'E' : 'W';
	return `${Math.abs(gps.lat).toFixed(5)}°${ns}, ${Math.abs(gps.lon).toFixed(5)}°${ew}`;
}

// ─── import ─────────────────────────────────────────────────────────────────

function ensureSubjectSidecar(subjectDir, slug, { dryRun, writeSidecars }) {
	if (!writeSidecars) return;
	const path = join(subjectDir, '_subject.yml');
	if (existsSync(path)) return;
	const content = `# Subject metadata for "${slug}"
# Edit on the drive; re-run import-portfolio to pick up changes.

title: ${yamlQuote(titleCase(slug))}
description: ""
order: 0
# cover: optional filename in this folder, e.g. IMG_0001.jpg
# cover:
`;
	if (dryRun) {
		console.log(`  sidecar ${path}`);
		return;
	}
	writeFileSync(path, content, 'utf8');
	console.log(`  + sidecar ${path}`);
}

function ensurePhotoSidecar(imagePath, { dryRun, writeSidecars }) {
	if (!writeSidecars) return;
	const path = imagePath.replace(extname(imagePath), '.yml');
	if (existsSync(path)) return;
	const content = `# Overrides for ${basename(imagePath)}
# Leave fields blank to keep EXIF / filename defaults.
# Display order defaults to filename (numeric); set order to override.

title: ""
caption: ""
location: ""
# date: YYYY-MM-DD
# order: 0
# hidden: false
`;
	if (dryRun) {
		console.log(`  sidecar ${path}`);
		return;
	}
	writeFileSync(path, content, 'utf8');
}

function titleCase(slug) {
	return slug
		.split(/[-_]/)
		.filter(Boolean)
		.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
		.join(' ');
}

/**
 * Stable short fingerprint of file bytes. Used as `?v=` so browsers treat
 * a re-export under the same S3 key as a new URL (CloudFront cache policy
 * ignores query strings, so the edge still keys on the object path).
 * @param {string} filePath
 */
function fileContentVersion(filePath) {
	if (!existsSync(filePath)) {
		// Fallback when cover filename is missing from disk
		try {
			const st = statSync(filePath);
			return `${st.size.toString(36)}`;
		} catch {
			return '0';
		}
	}
	const hash = createHash('sha256');
	hash.update(readFileSync(filePath));
	return hash.digest('hex').slice(0, 10);
}

/**
 * @param {string} baseUrl
 * @param {string} subject
 * @param {string} filename
 * @param {string} [localPath] absolute path for content-hash cache busting
 */
function buildImageUrl(baseUrl, subject, filename, localPath) {
	const base = baseUrl.replace(/\/+$/, '');
	const rel = `${subject}/${filename}`.split('/').map(encodeURIComponent).join('/');
	const url = `${base}/${rel}`;
	if (!localPath) return url;
	const v = fileContentVersion(localPath);
	return `${url}?v=${v}`;
}

function main() {
	const opts = parseArgs(process.argv.slice(2));
	if (opts.help) {
		printHelp();
		process.exit(0);
	}

	if (!opts.source) {
		console.error('Error: --source (or PORTFOLIO_SOURCE) is required.\n');
		printHelp();
		process.exit(1);
	}
	if (!opts.baseUrl) {
		console.error('Error: --base-url (or PHOTO_BASE_URL) is required.\n');
		printHelp();
		process.exit(1);
	}

	const sourceRoot = resolve(opts.source);
	const outRoot = resolve(opts.out);
	const subjectsOut = join(outRoot, 'src/content/subjects');
	const photosOut = join(outRoot, 'src/content/photos');

	if (!existsSync(sourceRoot)) {
		console.error(`Source not found: ${sourceRoot}`);
		console.error('Is the removable drive mounted?');
		process.exit(1);
	}

	console.log(`Source:   ${sourceRoot}`);
	console.log(`CDN base: ${opts.baseUrl.replace(/\/+$/, '')}`);
	console.log(`Output:   ${outRoot}`);
	if (opts.dryRun) console.log('(dry run)');
	console.log('');

	const subjectNames = listSubjectDirs(sourceRoot, opts.subject);
	if (!subjectNames.length) {
		console.error('No subject folders found.');
		process.exit(1);
	}

	/** @type {Set<string>} */
	const writtenSubjects = new Set();
	/** @type {Set<string>} */
	const writtenPhotos = new Set();

	let stats = { subjects: 0, photos: 0, unchanged: 0, sidecars: 0 };

	subjectNames.forEach((subjectSlug, subjectIndex) => {
		const subjectDir = join(sourceRoot, subjectSlug);
		const images = listImages(subjectDir);
		console.log(`● ${subjectSlug} (${images.length} images)`);

		ensureSubjectSidecar(subjectDir, subjectSlug, opts);

		const subjectMeta = readSubjectMeta(subjectDir);

		/** @type {Array<{ id: string, order: number, date?: string, filename: string, imageUrl: string, data: Record<string, unknown> }>} */
		const photoRecords = [];

		for (const filename of images) {
			const imagePath = join(subjectDir, filename);
			const sidecar = readSidecar(imagePath);
			if (sidecar.hidden === true || sidecar.hidden === 'true') {
				console.log(`  · skip hidden ${filename}`);
				continue;
			}

			if (opts.writeSidecars) {
				const before = existsSync(imagePath.replace(extname(imagePath), '.yml'));
				ensurePhotoSidecar(imagePath, opts);
				if (!before) stats.sidecars++;
			}

			const exif = extractMetadata(imagePath);
			const id = `${subjectSlug}-${slugify(basename(filename, extname(filename)))}`;
			const imageUrl = buildImageUrl(opts.baseUrl, subjectSlug, filename, imagePath);

			// Never use the file stem as a display title — leave blank unless
			// a sidecar or meaningful EXIF title provides one.
			const rawTitle =
				(typeof sidecar.title === 'string' && sidecar.title.trim()) ||
				exif.title ||
				'';
			const title = looksLikeFilename(rawTitle) ? '' : rawTitle;

			const caption =
				(typeof sidecar.caption === 'string' && sidecar.caption.trim()) ||
				exif.caption ||
				undefined;

			const location =
				(typeof sidecar.location === 'string' && sidecar.location.trim()) ||
				exif.location ||
				undefined;

			const date =
				(typeof sidecar.date === 'string' && sidecar.date.trim()) ||
				exif.date ||
				undefined;

			const order =
				typeof sidecar.order === 'number'
					? sidecar.order
					: typeof sidecar.order === 'string' && sidecar.order
						? Number(sidecar.order)
						: undefined;

			/** @type {Record<string, unknown>} */
			const data = {
				title,
				caption,
				subject: subjectSlug,
				location,
				date,
				image: imageUrl,
				width: exif.width,
				height: exif.height,
				order: order ?? 0,
				camera: exif.camera,
			};

			photoRecords.push({
				id,
				order: order ?? Number.MAX_SAFE_INTEGER,
				date,
				filename,
				imageUrl,
				data,
			});
		}

		// Default order: explicit sidecar order, then filename (numeric-aware).
		// Sequential renames like tree-01, tree-02 win over EXIF shoot date.
		photoRecords.sort((a, b) => {
			if (a.order !== b.order) return a.order - b.order;
			return a.filename.localeCompare(b.filename, undefined, {
				numeric: true,
				sensitivity: 'base',
			});
		});

		// Assign sequential order when still at default 0 / MAX
		photoRecords.forEach((rec, i) => {
			if (rec.data.order === 0 || rec.data.order === Number.MAX_SAFE_INTEGER) {
				rec.data.order = i + 1;
			}
		});

		// Cover: subject meta cover filename, else first photo
		let coverUrl;
		if (typeof subjectMeta.cover === 'string' && subjectMeta.cover.trim()) {
			const coverFile = subjectMeta.cover.trim();
			const coverPath = join(subjectDir, coverFile);
			coverUrl = buildImageUrl(opts.baseUrl, subjectSlug, coverFile, coverPath);
		} else if (photoRecords[0]) {
			coverUrl = photoRecords[0].imageUrl;
		} else {
			coverUrl = buildImageUrl(opts.baseUrl, subjectSlug, 'cover.jpg');
		}

		const subjectTitle =
			(typeof subjectMeta.title === 'string' && subjectMeta.title.trim()) ||
			titleCase(subjectSlug);
		const subjectDescription =
			typeof subjectMeta.description === 'string' ? subjectMeta.description.trim() : '';
		const subjectOrder =
			typeof subjectMeta.order === 'number'
				? subjectMeta.order
				: typeof subjectMeta.order === 'string' && subjectMeta.order
					? Number(subjectMeta.order)
					: subjectIndex + 1;

		const subjectMd = toFrontmatter({
			title: subjectTitle,
			description: subjectDescription,
			order: subjectOrder,
			cover: coverUrl,
		});

		const subjectPath = join(subjectsOut, `${subjectSlug}.md`);
		const subjectResult = writeGenerated(subjectPath, subjectMd, opts);
		writtenSubjects.add(`${subjectSlug}.md`);
		if (subjectResult === 'wrote' || subjectResult === 'would-write') stats.subjects++;
		else stats.unchanged++;

		for (const rec of photoRecords) {
			const photoPath = join(photosOut, `${rec.id}.md`);
			const content = toFrontmatter(rec.data);
			const result = writeGenerated(photoPath, content, opts);
			writtenPhotos.add(`${rec.id}.md`);
			if (result === 'wrote' || result === 'would-write') {
				stats.photos++;
				if (photoRecords.length <= 40) {
					console.log(`  ${result === 'would-write' ? '·' : '+'} ${rec.id}.md`);
				}
			} else {
				stats.unchanged++;
			}
		}
		if (photoRecords.length > 40) {
			console.log(`  … ${photoRecords.length} photos processed`);
		}
	});

	if (opts.clean) {
		for (const [dir, keep] of [
			[subjectsOut, writtenSubjects],
			[photosOut, writtenPhotos],
		]) {
			if (!existsSync(dir)) continue;
			for (const name of readdirSync(dir)) {
				if (!name.endsWith('.md')) continue;
				if (keep.has(name)) continue;
				// With --subject, only clean that subject's photos
				if (opts.subject) {
					if (dir === photosOut && !name.startsWith(`${opts.subject}-`)) continue;
					if (dir === subjectsOut && name !== `${opts.subject}.md`) continue;
				}
				const p = join(dir, name);
				if (opts.dryRun) {
					console.log(`  delete ${p}`);
				} else {
					unlinkSync(p);
					console.log(`  - removed ${relative(outRoot, p)}`);
				}
			}
		}
	}

	console.log('');
	console.log(
		`Done. subjects=${stats.subjects} photos=${stats.photos} unchanged=${stats.unchanged} sidecars=${stats.sidecars}`,
	);
	console.log('');
	console.log('Next:');
	console.log('  1. Edit titles/captions in drive sidecars (_subject.yml / photo.yml), then re-run');
	console.log('  2. Deploy stack (../stack) if needed, note PhotoBucketName output');
	console.log('  3. Sync images: ./scripts/sync-photos-s3.sh --source … --bucket <PhotoBucketName>');
	console.log('     (sync always invalidates the entire photo CDN afterward)');
}

try {
	main();
} catch (err) {
	console.error(err instanceof Error ? err.message : err);
	process.exit(1);
}
