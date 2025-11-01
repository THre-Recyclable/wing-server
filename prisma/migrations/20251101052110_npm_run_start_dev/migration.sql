-- CreateTable
CREATE TABLE "Node" (
    "id" TEXT NOT NULL,
    "userID" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "Node_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Edge" (
    "id" TEXT NOT NULL,
    "userID" TEXT NOT NULL,
    "startPoint" TEXT NOT NULL,
    "endPoint" TEXT NOT NULL,

    CONSTRAINT "Edge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "News" (
    "id" TEXT NOT NULL,
    "userID" TEXT NOT NULL,
    "edgeIndex" TEXT NOT NULL,
    "pubDate" TEXT NOT NULL,
    "link" TEXT NOT NULL,
    "description" TEXT NOT NULL,

    CONSTRAINT "News_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Node_userID_idx" ON "Node"("userID");
