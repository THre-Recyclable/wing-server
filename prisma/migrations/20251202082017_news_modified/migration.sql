/*
  Warnings:

  - Changed the type of `pubDate` on the `News` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.

*/
-- AlterTable
-- 1) pubDate 컬럼을 timestamptz로 변경하면서, 문자열을 timestamptz로 캐스팅
ALTER TABLE "News"
  ALTER COLUMN "pubDate"
  TYPE timestamptz
  USING "pubDate"::timestamptz;

-- 2) NOT NULL 유지 (이미 NOT NULL이면 생략 가능하지만 명시해둬도 됨)
ALTER TABLE "News"
  ALTER COLUMN "pubDate"
  SET NOT NULL;