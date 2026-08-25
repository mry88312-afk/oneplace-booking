-- ONE-147: 線上續約補上必填繳費方式，寫入 Ragic 1013721。
--
-- Scope:
--   booking_templates.bt_projectId = 'renewal'（正式 template 目前為 60001）
--   新增選項：月繳、半年繳、年繳
--   既有空白預約不回填
--
-- Safety:
--   1. 以 projectId 找 template，不把 60001 當唯一依據。
--   2. NOT EXISTS 防止重複執行產生第二個欄位。
--   3. 只調整同一 template 的 inbox_url 排序，不碰其他欄位或預約資料。

START TRANSACTION;

SET @one147_template_id := (
  SELECT bt_id
  FROM booking_templates
  WHERE bt_projectId = 'renewal'
    AND bt_isActive = 1
  LIMIT 1
);

UPDATE booking_form_fields
SET bff_sortOrder = 1
WHERE bff_templateId = @one147_template_id
  AND bff_fieldType = 'inbox_url'
  AND bff_ragicFieldId = '1022936';

INSERT INTO booking_form_fields (
  bff_templateId,
  bff_fieldType,
  bff_label,
  bff_isRequired,
  bff_options,
  bff_ragicFieldId,
  bff_descriptionText,
  bff_allowOther,
  bff_selectionMode,
  bff_sortOrder,
  bff_createdAt
)
SELECT
  @one147_template_id,
  'select',
  '繳費方式',
  1,
  JSON_ARRAY('月繳', '半年繳', '年繳'),
  '1013721',
  NULL,
  0,
  'checkbox',
  0,
  CURRENT_TIMESTAMP
WHERE @one147_template_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM booking_form_fields
    WHERE bff_templateId = @one147_template_id
      AND bff_label = '繳費方式'
      AND bff_ragicFieldId = '1013721'
  );

COMMIT;

-- Verification (expected: exactly one row, required=1, options in the stated order):
SELECT
  bff_id,
  bff_templateId,
  bff_label,
  bff_isRequired,
  bff_options,
  bff_ragicFieldId,
  bff_sortOrder
FROM booking_form_fields
WHERE bff_templateId = @one147_template_id
  AND bff_label = '繳費方式'
  AND bff_ragicFieldId = '1013721';

-- Rollback (run separately only if ONE-147 must be reverted):
-- START TRANSACTION;
-- SET @one147_template_id := (
--   SELECT bt_id
--   FROM booking_templates
--   WHERE bt_projectId = 'renewal'
--   LIMIT 1
-- );
-- DELETE FROM booking_form_fields
-- WHERE bff_templateId = @one147_template_id
--   AND bff_label = '繳費方式'
--   AND bff_ragicFieldId = '1013721'
--   AND bff_fieldType = 'select'
--   AND bff_options = JSON_ARRAY('月繳', '半年繳', '年繳');
-- UPDATE booking_form_fields
-- SET bff_sortOrder = 0
-- WHERE bff_templateId = @one147_template_id
--   AND bff_fieldType = 'inbox_url'
--   AND bff_ragicFieldId = '1022936';
-- COMMIT;
