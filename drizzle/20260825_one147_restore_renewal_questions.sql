-- ONE-147 P106: 恢復線上續約遺失的入住人數與續約備註。
--
-- Scope:
--   booking_templates.bt_projectId = 'renewal'（正式 template 目前為 60001）
--   繳費方式 → 入住人數 → 續約備註 → 隱藏對話網址
--   只影響修正後的新單，不回填既有預約或 Ragic 記錄
--
-- Safety:
--   1. 以 projectId 找 active template，不把 60001 當唯一依據。
--   2. NOT EXISTS 防止重複執行產生同名欄位。
--   3. 入住人數與續約備註不設定 Ragic ID；1013722 是展延費用備註，不可誤用。
--   4. 只調整本次四個已知欄位的排序，不碰其他欄位或預約資料。

START TRANSACTION;

SET @one147_template_id := (
  SELECT bt_id
  FROM booking_templates
  WHERE bt_projectId = 'renewal'
    AND bt_isActive = 1
  LIMIT 1
);

UPDATE booking_form_fields
SET bff_sortOrder = 0
WHERE bff_templateId = @one147_template_id
  AND bff_label = '繳費方式'
  AND bff_ragicFieldId = '1013721';

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
  'text',
  '入住人數',
  1,
  NULL,
  NULL,
  NULL,
  0,
  'checkbox',
  1,
  CURRENT_TIMESTAMP
WHERE @one147_template_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM booking_form_fields
    WHERE bff_templateId = @one147_template_id
      AND bff_label = '入住人數'
  );

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
  'text',
  '續約備註',
  0,
  NULL,
  NULL,
  NULL,
  0,
  'checkbox',
  2,
  CURRENT_TIMESTAMP
WHERE @one147_template_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM booking_form_fields
    WHERE bff_templateId = @one147_template_id
      AND bff_label = '續約備註'
  );

UPDATE booking_form_fields
SET bff_sortOrder = 3
WHERE bff_templateId = @one147_template_id
  AND bff_fieldType = 'inbox_url'
  AND bff_ragicFieldId = '1022936';

COMMIT;

-- Verification (expected: exactly four rows in sort order 0..3):
SELECT
  bff_id,
  bff_templateId,
  bff_label,
  bff_fieldType,
  bff_isRequired,
  bff_options,
  bff_ragicFieldId,
  bff_sortOrder
FROM booking_form_fields
WHERE bff_templateId = @one147_template_id
  AND (
    (bff_label = '繳費方式' AND bff_ragicFieldId = '1013721')
    OR bff_label IN ('入住人數', '續約備註')
    OR (bff_fieldType = 'inbox_url' AND bff_ragicFieldId = '1022936')
  )
ORDER BY bff_sortOrder, bff_id;

-- Rollback (run separately only if this question restoration must be reverted):
-- START TRANSACTION;
-- SET @one147_template_id := (
--   SELECT bt_id
--   FROM booking_templates
--   WHERE bt_projectId = 'renewal'
--     AND bt_isActive = 1
--   LIMIT 1
-- );
-- DELETE FROM booking_form_fields
-- WHERE bff_templateId = @one147_template_id
--   AND bff_label IN ('入住人數', '續約備註')
--   AND bff_fieldType = 'text'
--   AND bff_ragicFieldId IS NULL;
-- UPDATE booking_form_fields
-- SET bff_sortOrder = 1
-- WHERE bff_templateId = @one147_template_id
--   AND bff_fieldType = 'inbox_url'
--   AND bff_ragicFieldId = '1022936';
-- COMMIT;
