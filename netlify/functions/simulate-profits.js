// netlify/functions/simulate-profits.js
const admin = require('firebase-admin');

// Initialize Firebase Admin
try {
  // This securely pulls the service account from your Netlify environment variables
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  }
} catch (e) {
  console.error('Failed to initialize Firebase Admin:', e);
}
const db = admin.firestore();

// --- CONFIGURATION ---
const PEAK_HOURS_START = 16; // 4 PM
const PEAK_HOURS_END = 22; // 10 PM
const PEAK_HOUR_MULTIPLIER = 1.25;

const PACKAGES = {
  'Standard Port': {
    sessions: {
      slow: { chance: 0.2, min: 7.00, max: 11.00 },
      standard: { chance: 0.6, min: 11.00, max: 16.00 },
      busy: { chance: 0.2, min: 16.00, max: 22.00 },
    }
  },
  'High-Traffic Pro Port': {
    sessions: {
      slow: { chance: 0.2, min: 12.00, max: 18.00 },
      standard: { chance: 0.6, min: 18.00, max: 24.00 },
      busy: { chance: 0.2, min: 24.00, max: 32.00 },
    }
  }
};

// --- HELPER FUNCTIONS ---
const getRandomProfit = (config) => {
  const rand = Math.random();
  let cumulativeChance = 0;
  // Define the order of session types for probability check
  const sessionTypes = ['slow', 'standard', 'busy'];
  for (const type of sessionTypes) {
    cumulativeChance += config.sessions[type].chance;
    if (rand < cumulativeChance) {
      const { min, max } = config.sessions[type];
      return parseFloat((Math.random() * (max - min) + min).toFixed(2));
    }
  }
  // Fallback to the standard session if something goes wrong
  const { min, max } = config.sessions.standard;
  return parseFloat((Math.random() * (max - min) + min).toFixed(2));
};

const getDynamicDescription = (portData, portId) => {
    const location = portData.locationName || 'Unknown Location';
    const identifier = portData.portIdentifier || `Port #${portId.substring(0,4)}`;
    return `Earning from ${location} (${identifier})`;
};

// --- MAIN HANDLER ---
exports.handler = async function(event, context) {
  console.log("Starting profit simulation run...");
  const currentHour = new Date().getUTCHours(); // Use UTC for consistency
  const isPeakHour = currentHour >= PEAK_HOURS_START && currentHour <= PEAK_HOURS_END;

  try {
    const portsSnapshot = await db.collectionGroup('ports').where('status', '==', 'Active').get();
    if (portsSnapshot.empty) {
      return { statusCode: 200, body: "No active ports found." };
    }

    const promises = [];

    for (const portDoc of portsSnapshot.docs) {
      const portData = portDoc.data();
      const packageConfig = PACKAGES[portData.package];
      if (!packageConfig) continue;

      // Every active port gets one session per hour
      let profit = getRandomProfit(packageConfig);

      if (isPeakHour) {
        profit = parseFloat((profit * PEAK_HOUR_MULTIPLIER).toFixed(2));
      }

      const userId = portDoc.ref.parent.parent.id;
      const portId = portDoc.id;
      
      console.log(`Generating profit of $${profit} for user ${userId} on port ${portId}`);

      const batch = db.batch();
      const userRef = db.collection('users').doc(userId);

      // ===================================================================
      // ===> THE FIX IS APPLIED HERE <===
      // We are adding lifetimeEarnings to the update on the main user document.
      // If the field doesn't exist, Firestore creates it. If it does, it increments it.
      batch.update(userRef, {
        availableBalance: admin.firestore.FieldValue.increment(profit),
        monthlyEarnings: admin.firestore.FieldValue.increment(profit),
        lifetimeEarnings: admin.firestore.FieldValue.increment(profit) // <-- THIS LINE IS THE FIX
      });
      // ===================================================================

      const portRef = db.collection('users').doc(userId).collection('ports').doc(portId);
      // We also keep updating the earnings on the individual port for detailed stats
      batch.update(portRef, {
        lifetimeEarnings: admin.firestore.FieldValue.increment(profit),
        monthlyEarnings: admin.firestore.FieldValue.increment(profit)
      });

      const activityRef = userRef.collection('activity').doc();
      batch.set(activityRef, {
        type: 'earning',
        amount: profit,
        description: getDynamicDescription(portData, portId),
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        portId: portId
      });

      promises.push(batch.commit());
    }

    await Promise.all(promises);
    const body = `Simulation complete. Processed ${promises.length} transactions.`;
    console.log(body);
    return { statusCode: 200, body };

  } catch (error) {
    console.error("Error during profit simulation:", error);
    return { statusCode: 500, body: "An error occurred during simulation." };
  }
};