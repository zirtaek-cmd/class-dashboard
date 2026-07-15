import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";

const firebaseConfig = {
  apiKey: "AIzaSyCYtYZ7cG1KNY7x_wj621P02LlmU0xCodw",
  authDomain: "class-dashboard-a52f5.firebaseapp.com",
  projectId: "class-dashboard-a52f5",
  storageBucket: "class-dashboard-a52f5.firebasestorage.app",
  messagingSenderId: "578126293240",
  appId: "1:578126293240:web:71839b8aa2929f11d2730d",
};

const app = initializeApp(firebaseConfig);

export const db = getFirestore(app);
export const auth = getAuth(app);
