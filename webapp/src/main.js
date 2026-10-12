import { createApp } from 'vue'
import App from './App.vue'
import router from './router.js'
import { initTelegram } from './composables/useTelegram.js'
import './styles/tokens.css'
import './styles/main.css'
import './styles/transitions.css'

initTelegram()

createApp(App).use(router).mount('#app')
