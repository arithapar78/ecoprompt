const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");

admin.initializeApp();

const db = admin.firestore();

function isValidMetricEvent(data) {
  return (
    data &&
    typeof data.userId === "string" &&
    typeof data.eventId === "string" &&
    typeof data.timestamp === "string" &&
    typeof data.date === "string" &&
    typeof data.month === "string" &&
    typeof data.originalTokens === "number" &&
    typeof data.optimizedTokens === "number" &&
    typeof data.tokensSaved === "number" &&
    data.originalTokens >= 0 &&
    data.optimizedTokens >= 0 &&
    data.tokensSaved >= 0 &&
    data.originalTokens < 100000 &&
    data.optimizedTokens < 100000 &&
    data.tokensSaved < 100000
  );
}

exports.trackOptimizationEvent = onRequest(
  {
    cors: true,
    region: "us-east1"
  },
  async (req, res) => {
    try {
      if (req.method !== "POST") {
        return res.status(405).json({ error: "Method not allowed" });
      }

      const data = req.body;

      if (!isValidMetricEvent(data)) {
        return res.status(400).json({ error: "Invalid metric event" });
      }

      const eventRef = db.collection("optimizationEvents").doc(data.eventId);
      const userRef = db.collection("users").doc(data.userId);
      const dailyRef = db.collection("dailyUserStats").doc(`${data.userId}_${data.date}`);
      const monthlyRef = db.collection("monthlyUserStats").doc(`${data.userId}_${data.month}`);

      await db.runTransaction(async (transaction) => {
        transaction.set(eventRef, {
          ...data,
          receivedAt: admin.firestore.FieldValue.serverTimestamp()
        });

        transaction.set(
          userRef,
          {
            userId: data.userId,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            lastActiveAt: admin.firestore.FieldValue.serverTimestamp(),
            extensionVersion: data.extensionVersion || "unknown"
          },
          { merge: true }
        );

        transaction.set(
          dailyRef,
          {
            userId: data.userId,
            date: data.date,
            promptsOptimized: admin.firestore.FieldValue.increment(1),
            originalTokens: admin.firestore.FieldValue.increment(data.originalTokens),
            optimizedTokens: admin.firestore.FieldValue.increment(data.optimizedTokens),
            tokensSaved: admin.firestore.FieldValue.increment(data.tokensSaved),
            lastEventAt: data.timestamp
          },
          { merge: true }
        );

        transaction.set(
          monthlyRef,
          {
            userId: data.userId,
            month: data.month,
            promptsOptimized: admin.firestore.FieldValue.increment(1),
            originalTokens: admin.firestore.FieldValue.increment(data.originalTokens),
            optimizedTokens: admin.firestore.FieldValue.increment(data.optimizedTokens),
            tokensSaved: admin.firestore.FieldValue.increment(data.tokensSaved),
            lastEventAt: data.timestamp
          },
          { merge: true }
        );
      });

      return res.status(200).json({ success: true });
    } catch (error) {
      console.error("trackOptimizationEvent failed:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  }
);