# WindAim

Iridium（Minecraft 1.20.1 Forge）战斗脚本：按住攻击瞄准目标碰撞箱上离眼睛最近的点。

把 `WindAim.js` 放到 `%APPDATA%\scripts\`，进游戏后在 Click GUI → Combat 打开 **WindAim**。

## 设置

| 项 | 说明 |
|---|---|
| Mode | `WindMouse` 曲线贴近 / `Lock` 直接锁到碰撞箱 |
| Speed | WindMouse 整体转头速度 |
| Targets | Players / Living / Monsters |
| Skip Mining | 挖方块时不瞄 |

按住攻击键才会瞄准。准星已经打在碰撞箱上时不再抢鼠标。

瞄准路径参考 [WindMouse](https://github.com/AsfhtgkDavid/windmouse)（GPLv3，原算法 [Ben Land](https://ben.land/post/2021/04/25/windmouse-human-mouse-movement/)）。
