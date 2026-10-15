CC ?= cc
CFLAGS ?= -std=c11 -Wall -Wextra -Werror -O1 -I../main

test_dsp_proto: test_dsp_proto.c ../main/dsp_proto.c ../main/dsp_proto.h
	$(CC) $(CFLAGS) -o $@ test_dsp_proto.c ../main/dsp_proto.c -lm

.PHONY: test clean
test: test_dsp_proto
	./test_dsp_proto

clean:
	rm -f test_dsp_proto
