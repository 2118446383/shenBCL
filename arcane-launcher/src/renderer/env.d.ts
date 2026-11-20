/// <reference types="vite/client" />
import type { AppBridge } from '../shared/contracts'
declare global { interface Window { arcane?: AppBridge } }
