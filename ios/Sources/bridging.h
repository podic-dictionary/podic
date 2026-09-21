#ifndef PODIC_BRIDGING_H
#define PODIC_BRIDGING_H

#include <stdint.h>

/// 启动完整 podic 后端，返回实际监听端口；已启动幂等返回，失败 -1
int32_t podic_start_server(const char *data_dir, int32_t port);

#endif
