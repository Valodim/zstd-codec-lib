#ifndef _STRING_H
#define _STRING_H

#include "stddef.h"

void* memcpy(void* dest, const void* src, size_t n);
void* memset(void* s, int c, size_t n);
void* memmove(void* dest, const void* src, size_t n);

#endif

