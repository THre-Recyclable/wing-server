/*
  Warnings:

  - A unique constraint covering the columns `[userID,startPoint,endPoint]` on the table `Edge` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[userID,name]` on the table `Node` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE UNIQUE INDEX "Edge_userID_startPoint_endPoint_key" ON "Edge"("userID", "startPoint", "endPoint");

-- CreateIndex
CREATE UNIQUE INDEX "Node_userID_name_key" ON "Node"("userID", "name");
