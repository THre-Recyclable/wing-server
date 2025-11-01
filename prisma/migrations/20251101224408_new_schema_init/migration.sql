/*
  Warnings:

  - Added the required column `sentiment_label` to the `Edge` table without a default value. This is not possible if the table is not empty.
  - Added the required column `sentiment_score` to the `Edge` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "Edge" ADD COLUMN     "sentiment_label" TEXT NOT NULL,
ADD COLUMN     "sentiment_score" DOUBLE PRECISION NOT NULL;
