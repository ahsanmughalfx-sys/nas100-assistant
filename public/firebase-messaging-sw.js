importScripts("https://www.gstatic.com/firebasejs/10.7.1/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.7.1/firebase-messaging-compat.js");

firebase.initializeApp({
  apiKey: "AIzaSyDwePLqUQoQWf_3kuZ6onGINQzvxTzXe",
  authDomain: "nas100-trading.firebaseapp.com",
  projectId: "nas100-trading",
  storageBucket: "nas100-trading.firebasestorage.app",
  messagingSenderId: "762900104928",
  appId: "1:762900104928:web:7daa9408715923a6657285"
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
  console.log("📱 Background message:", payload);
  const notificationTitle = payload.notification?.title || "New Setup Alert";
  const notificationOptions = {
    body: payload.notification?.body || "Check dashboard for details",
    icon: "/icon.png"
  };
  self.registration.showNotification(notificationTitle, notificationOptions);
});
