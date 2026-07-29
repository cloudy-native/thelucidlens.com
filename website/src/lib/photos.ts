import { getCollection, type CollectionEntry } from 'astro:content';

export async function getSubjects() {
	const subjects = await getCollection('subjects');
	return subjects.sort((a, b) => a.data.order - b.data.order || a.data.title.localeCompare(b.data.title));
}

export async function getPhotosBySubject(subjectId: string) {
	const photos = await getCollection('photos', ({ data }) => data.subject === subjectId);
	return photos.sort((a, b) => a.data.order - b.data.order || a.id.localeCompare(b.id));
}

export async function getPhotoCounts(): Promise<Map<string, number>> {
	const photos = await getCollection('photos');
	const counts = new Map<string, number>();
	for (const photo of photos) {
		const key = photo.data.subject;
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	return counts;
}

/**
 * Camera / export filenames should never surface in the UI.
 * Only human titles (from sidecars) or captions are displayable.
 */
export function isCameraFilename(value: string | undefined | null): boolean {
	if (!value) return true;
	const t = value.trim();
	if (!t) return true;

	// DSC_0184, IMG 1493, P1000927, _DSC0145, DSCN, etc.
	if (/^(?:_?DSC(?:N|F)?|IMG|P\d{3,}|fullsizeoutput)[\s_-]*/i.test(t)) return true;
	// UUID-like
	if (/^[0-9a-f]{8}(?:-?[0-9a-f]{4}){3}-?[0-9a-f]{12}$/i.test(t.replace(/\s/g, ''))) return true;
	// Long numeric / iOS export prefixes
	if (/^\d{8,}(?:__|-)/.test(t.replace(/\s/g, ''))) return true;
	// Base64-ish export names with little structure
	if (/^[A-Za-z0-9+_-]{16,}$/.test(t.replace(/\s/g, ''))) return true;
	// "IMG 1055 jpg" style from bad stems
	if (/\b(?:jpg|jpeg|png|webp|heic)\b/i.test(t) && /img|dsc/i.test(t)) return true;

	return false;
}

/** Title only when it's a real label — never a file stem. */
export function displayTitle(title: string | undefined, caption?: string): string | undefined {
	if (caption?.trim()) {
		// Prefer explicit title when human; otherwise caption stands alone
	}
	if (title && !isCameraFilename(title)) return title.trim();
	return undefined;
}

export type SubjectEntry = CollectionEntry<'subjects'>;
export type PhotoEntry = CollectionEntry<'photos'>;
