/*
  Warnings:

  - Added the required column `weight` to the `Edge` table without a default value. This is not possible if the table is not empty.
  - Added the required column `weight` to the `Node` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "Edge" ADD COLUMN     "weight" DOUBLE PRECISION NOT NULL;

-- AlterTable
ALTER TABLE "Node" ADD COLUMN     "weight" DOUBLE PRECISION NOT NULL;
