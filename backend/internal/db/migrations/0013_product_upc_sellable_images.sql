-- 0013: product UPC/barcode, sellable flag, and multiple images.
ALTER TABLE products ADD COLUMN IF NOT EXISTS upc      text    NOT NULL DEFAULT '';
ALTER TABLE products ADD COLUMN IF NOT EXISTS sellable boolean NOT NULL DEFAULT true;
ALTER TABLE products ADD COLUMN IF NOT EXISTS images   jsonb   NOT NULL DEFAULT '[]'::jsonb;

-- seed the images array from the existing single image_url (images[0] = main)
UPDATE products SET images = jsonb_build_array(image_url)
 WHERE image_url IS NOT NULL AND image_url <> '' AND images = '[]'::jsonb;
