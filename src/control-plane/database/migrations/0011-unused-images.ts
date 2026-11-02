export const unusedImagesMigration = {
  version: 11,
  name: "unused-images",
  sql: `
-- The images no container on the host uses, as its runner last reported them; null until it does.
ALTER TABLE hosts ADD COLUMN unused_images_json TEXT;
-- The images a removal names; null for every other job.
ALTER TABLE jobs ADD COLUMN images_json TEXT;
`,
};
