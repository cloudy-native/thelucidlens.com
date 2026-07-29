import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const subjects = defineCollection({
	loader: glob({ pattern: '**/*.md', base: './src/content/subjects' }),
	schema: z.object({
		title: z.string(),
		/** Optional blurb under the subject title; omit for title-only headers. */
		description: z.string().default(''),
		/** Lower numbers appear first on the home page. */
		order: z.number().default(0),
		/** Absolute CDN URL, e.g. https://photos.thelucidlens.com/city/cover.jpg */
		cover: z.string(),
	}),
});

const photos = defineCollection({
	loader: glob({ pattern: '**/*.md', base: './src/content/photos' }),
	schema: z.object({
		/** Optional human title — camera filenames are not displayed in the UI. */
		title: z.string().default(''),
		caption: z.string().optional(),
		/** Subject collection slug (filename without extension). */
		subject: z.string(),
		location: z.string().optional(),
		date: z.coerce.date().optional(),
		/** Absolute CDN URL, e.g. https://photos.thelucidlens.com/city/IMG_1493.jpg */
		image: z.string(),
		/** Optional width/height hints for layout (placeholders or known dimensions). */
		width: z.number().optional(),
		height: z.number().optional(),
		order: z.number().default(0),
		camera: z
			.object({
				body: z.string().optional(),
				lens: z.string().optional(),
				aperture: z.string().optional(),
				shutter: z.string().optional(),
				iso: z.union([z.string(), z.number()]).optional(),
				focalLength: z.string().optional(),
			})
			.optional(),
	}),
});

export const collections = { subjects, photos };
