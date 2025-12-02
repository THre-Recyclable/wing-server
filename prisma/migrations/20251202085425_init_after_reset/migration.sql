/*
  Warnings:

  - A unique constraint covering the columns `[graphId,startPoint,endPoint]` on the table `Edge` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[graphId,name]` on the table `Node` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `graphId` to the `Edge` table without a default value. This is not possible if the table is not empty.
  - Added the required column `graphId` to the `News` table without a default value. This is not possible if the table is not empty.
  - Added the required column `graphId` to the `Node` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "KeywordType" AS ENUM ('MAIN', 'SUB');

-- DropIndex
DROP INDEX "Edge_userID_startPoint_endPoint_key";

-- DropIndex
DROP INDEX "Node_userID_name_key";

-- AlterTable
ALTER TABLE "Edge" ADD COLUMN     "collectedCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "graphId" INTEGER NOT NULL,
ADD COLUMN     "totalEstimated" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "News" ADD COLUMN     "graphId" INTEGER NOT NULL;

-- AlterTable
ALTER TABLE "Node" ADD COLUMN     "graphId" INTEGER NOT NULL,
ADD COLUMN     "kind" "KeywordType" NOT NULL DEFAULT 'SUB';

-- CreateTable
CREATE TABLE "Graph" (
    "id" SERIAL NOT NULL,
    "userID" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Graph_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Graph_userID_idx" ON "Graph"("userID");

-- CreateIndex
CREATE INDEX "Edge_userID_idx" ON "Edge"("userID");

-- CreateIndex
CREATE INDEX "Edge_graphId_idx" ON "Edge"("graphId");

-- CreateIndex
CREATE UNIQUE INDEX "Edge_graphId_startPoint_endPoint_key" ON "Edge"("graphId", "startPoint", "endPoint");

-- CreateIndex
CREATE INDEX "News_userID_idx" ON "News"("userID");

-- CreateIndex
CREATE INDEX "News_graphId_idx" ON "News"("graphId");

-- CreateIndex
CREATE INDEX "Node_graphId_idx" ON "Node"("graphId");

-- CreateIndex
CREATE UNIQUE INDEX "Node_graphId_name_key" ON "Node"("graphId", "name");

-- AddForeignKey
ALTER TABLE "Graph" ADD CONSTRAINT "Graph_userID_fkey" FOREIGN KEY ("userID") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Node" ADD CONSTRAINT "Node_graphId_fkey" FOREIGN KEY ("graphId") REFERENCES "Graph"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Edge" ADD CONSTRAINT "Edge_graphId_fkey" FOREIGN KEY ("graphId") REFERENCES "Graph"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "News" ADD CONSTRAINT "News_graphId_fkey" FOREIGN KEY ("graphId") REFERENCES "Graph"("id") ON DELETE CASCADE ON UPDATE CASCADE;
