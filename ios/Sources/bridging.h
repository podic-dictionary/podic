#ifndef PODIC_BRIDGING_H
#define PODIC_BRIDGING_H

#include <stdint.h>

/// 启动完整 podic 后端，返回实际监听端口；已启动幂等返回（实例死了自愈重启），失败 -1
int32_t podic_start_server(const char *data_dir, int32_t port);

/// 强制重启后端（健康探测失败时壳调用），返回新端口（优先复用原端口），失败 -1
int32_t podic_restart_server(void);

/// 服务线程是否存活（0/1）
int32_t podic_server_alive(void);

#endif
