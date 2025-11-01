/*
  Warnings:

  - You are about to drop the column `edgeIndex` on the `News` table. All the data in the column will be lost.
  - Added the required column `endPoint` to the `News` table without a default value. This is not possible if the table is not empty.
  - Added the required column `startPoint` to the `News` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "News" DROP COLUMN "edgeIndex",
ADD COLUMN     "endPoint" TEXT NOT NULL,
ADD COLUMN     "startPoint" TEXT NOT NULL;
