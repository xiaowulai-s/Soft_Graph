import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import './styles/tailwind.css'
import './styles/theme.css'
/* DiskMirror 皮肤：必须排在 tailwind + theme 之后（无层级样式覆盖 @layer base 令牌） */
import './styles/dm-skin.css'

createApp(App).use(createPinia()).mount('#app')
