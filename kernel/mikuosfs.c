// SPDX-License-Identifier: GPL-2.0-only
/*
 * mikuosfs: host-backed root filesystem for NERU/Linux-WASM.
 *
 * This first bootable slice is deliberately read-only. It forwards metadata,
 * directory enumeration, file reads and symlink reads to synchronous host
 * callbacks supplied by the NERU worker.
 */

#include <linux/dcache.h>
#include <linux/err.h>
#include <linux/fs.h>
#include <linux/fs_context.h>
#include <linux/init.h>
#include <linux/kernel.h>
#include <linux/limits.h>
#include <linux/module.h>
#include <linux/namei.h>
#include <linux/pagemap.h>
#include <linux/slab.h>
#include <linux/stat.h>
#include <linux/uio.h>

#define MIKUOSFS_MAGIC 0x4d494b55
#define MIKUOSFS_READ_CHUNK (64 * 1024)

/* These unresolved symbols become WebAssembly imports from module "env". */
extern long wasm_mikuosfs_mode(const char *path);
extern long long wasm_mikuosfs_size(const char *path);
extern long wasm_mikuosfs_read(const char *path, long long offset,
			       void *buffer, unsigned long count);
extern long wasm_mikuosfs_readdir(const char *path, unsigned long index,
				  char *buffer, unsigned long count);
extern long wasm_mikuosfs_readlink(const char *path, char *buffer,
				   unsigned long count);

static const struct inode_operations mikuosfs_dir_inode_operations;
static const struct file_operations mikuosfs_dir_operations;
static const struct file_operations mikuosfs_file_operations;

static int mikuosfs_path_from_dentry(const struct dentry *dentry,
				     char *buffer, size_t size)
{
	const struct dentry *cursor = dentry;
	char *end = buffer + size;
	char *position = end;

	if (size < 2)
		return -ENAMETOOLONG;
	*--position = '\0';

	while (!IS_ROOT(cursor)) {
		size_t length = cursor->d_name.len;

		if (length == 0 || length > NAME_MAX)
			return -ENAMETOOLONG;
		if ((size_t)(position - buffer) < length + 1)
			return -ENAMETOOLONG;
		position -= length;
		memcpy(position, cursor->d_name.name, length);
		*--position = '/';
		cursor = cursor->d_parent;
	}

	if (*position == '\0') {
		if (position == buffer)
			return -ENAMETOOLONG;
		*--position = '/';
	}

	memmove(buffer, position, end - position);
	return 0;
}

static void mikuosfs_evict_inode(struct inode *inode)
{
	truncate_inode_pages_final(&inode->i_data);
	clear_inode(inode);
	if (S_ISLNK(inode->i_mode))
		kfree(inode->i_link);
	kfree(inode->i_private);
}

static const struct super_operations mikuosfs_super_operations = {
	.statfs = simple_statfs,
	.evict_inode = mikuosfs_evict_inode,
};

static struct inode *mikuosfs_new_inode(struct super_block *sb,
					const struct inode *parent,
					const char *path,
					umode_t mode,
					loff_t size)
{
	struct inode *inode;
	char *stored_path;

	inode = new_inode(sb);
	if (!inode)
		return ERR_PTR(-ENOMEM);

	stored_path = kstrdup(path, GFP_KERNEL);
	if (!stored_path) {
		iput(inode);
		return ERR_PTR(-ENOMEM);
	}

	inode->i_ino = get_next_ino();
	inode_init_owner(&nop_mnt_idmap, inode, parent, mode);
	simple_inode_init_ts(inode);
	inode->i_private = stored_path;
	i_size_write(inode, size < 0 ? 0 : size);

	if (S_ISDIR(mode)) {
		inode->i_op = &mikuosfs_dir_inode_operations;
		inode->i_fop = &mikuosfs_dir_operations;
		inc_nlink(inode);
	} else if (S_ISREG(mode)) {
		inode->i_fop = &mikuosfs_file_operations;
	} else if (S_ISLNK(mode)) {
		char *target = kmalloc(PATH_MAX, GFP_KERNEL);
		long result;

		if (!target) {
			iput(inode);
			return ERR_PTR(-ENOMEM);
		}
		result = wasm_mikuosfs_readlink(path, target, PATH_MAX);
		if (result < 0) {
			kfree(target);
			iput(inode);
			return ERR_PTR(result);
		}
		if (result >= PATH_MAX)
			result = PATH_MAX - 1;
		target[result] = '\0';
		inode->i_link = target;
		inode->i_op = &simple_symlink_inode_operations;
		i_size_write(inode, result);
	} else {
		init_special_inode(inode, mode, 0);
	}

	return inode;
}

static struct dentry *mikuosfs_lookup(struct inode *directory,
				      struct dentry *dentry,
				      unsigned int flags)
{
	char path[PATH_MAX];
	struct inode *inode;
	long mode;
	long long size;
	int error;

	(void)flags;
	error = mikuosfs_path_from_dentry(dentry, path, sizeof(path));
	if (error)
		return ERR_PTR(error);

	mode = wasm_mikuosfs_mode(path);
	if (mode == -ENOENT) {
		d_add(dentry, NULL);
		return NULL;
	}
	if (mode < 0)
		return ERR_PTR(mode);

	size = wasm_mikuosfs_size(path);
	if (size < 0)
		return ERR_PTR((long)size);

	inode = mikuosfs_new_inode(directory->i_sb, directory, path,
				    (umode_t)mode, (loff_t)size);
	if (IS_ERR(inode))
		return ERR_CAST(inode);

	return d_splice_alias(inode, dentry);
}

static const struct inode_operations mikuosfs_dir_inode_operations = {
	.lookup = mikuosfs_lookup,
};

static int mikuosfs_iterate(struct file *file, struct dir_context *context)
{
	const char *path = file_inode(file)->i_private;
	unsigned long index;
	char name[NAME_MAX + 1];

	if (!dir_emit_dots(file, context))
		return 0;

	index = context->pos - 2;
	for (;;) {
		long result = wasm_mikuosfs_readdir(path, index, name,
						   sizeof(name));

		if (result == 0)
			return 0;
		if (result < 0)
			return result;
		if (result > NAME_MAX)
			return -ENAMETOOLONG;
		name[result] = '\0';
		if (!dir_emit(context, name, result, 0, DT_UNKNOWN))
			return 0;
		context->pos++;
		index++;
	}
}

static const struct file_operations mikuosfs_dir_operations = {
	.owner = THIS_MODULE,
	.llseek = generic_file_llseek,
	.iterate_shared = mikuosfs_iterate,
};

static ssize_t mikuosfs_read_iter(struct kiocb *iocb, struct iov_iter *target)
{
	struct inode *inode = file_inode(iocb->ki_filp);
	const char *path = inode->i_private;
	ssize_t total = 0;
	char *buffer;

	if (iocb->ki_pos >= i_size_read(inode))
		return 0;

	buffer = kmalloc(MIKUOSFS_READ_CHUNK, GFP_KERNEL);
	if (!buffer)
		return -ENOMEM;

	while (iov_iter_count(target) && iocb->ki_pos < i_size_read(inode)) {
		size_t remaining = i_size_read(inode) - iocb->ki_pos;
		size_t count = min_t(size_t, iov_iter_count(target),
				     MIKUOSFS_READ_CHUNK);
		long result;
		size_t copied;

		count = min(count, remaining);
		result = wasm_mikuosfs_read(path, iocb->ki_pos, buffer, count);
		if (result < 0) {
			if (!total)
				total = result;
			break;
		}
		if (result == 0)
			break;
		if ((size_t)result > count) {
			if (!total)
				total = -EIO;
			break;
		}

		copied = copy_to_iter(buffer, result, target);
		if (copied != (size_t)result) {
			if (!total)
				total = -EFAULT;
			break;
		}
		iocb->ki_pos += copied;
		total += copied;
		if ((size_t)result < count)
			break;
	}

	kfree(buffer);
	return total;
}

static const struct file_operations mikuosfs_file_operations = {
	.owner = THIS_MODULE,
	.llseek = generic_file_llseek,
	.read_iter = mikuosfs_read_iter,
};

static int mikuosfs_fill_super(struct super_block *sb, struct fs_context *fc)
{
	struct inode *root_inode;
	long mode;
	long long size;

	(void)fc;
	mode = wasm_mikuosfs_mode("/");
	if (mode < 0)
		return mode;
	if (!S_ISDIR((umode_t)mode))
		return -ENOTDIR;

	size = wasm_mikuosfs_size("/");
	if (size < 0)
		return (long)size;

	sb->s_magic = MIKUOSFS_MAGIC;
	sb->s_maxbytes = MAX_LFS_FILESIZE;
	sb->s_blocksize = PAGE_SIZE;
	sb->s_blocksize_bits = PAGE_SHIFT;
	sb->s_op = &mikuosfs_super_operations;
	sb->s_d_flags = DCACHE_DONTCACHE;
	sb->s_time_gran = 1;

	root_inode = mikuosfs_new_inode(sb, NULL, "/", (umode_t)mode,
					 (loff_t)size);
	if (IS_ERR(root_inode))
		return PTR_ERR(root_inode);

	sb->s_root = d_make_root(root_inode);
	return sb->s_root ? 0 : -ENOMEM;
}

static int mikuosfs_get_tree(struct fs_context *fc)
{
	return get_tree_nodev(fc, mikuosfs_fill_super);
}

static const struct fs_context_operations mikuosfs_context_operations = {
	.get_tree = mikuosfs_get_tree,
};

static int mikuosfs_init_fs_context(struct fs_context *fc)
{
	fc->ops = &mikuosfs_context_operations;
	return 0;
}

static struct file_system_type mikuosfs_type = {
	.owner = THIS_MODULE,
	.name = "mikuosfs",
	.init_fs_context = mikuosfs_init_fs_context,
	.kill_sb = kill_anon_super,
	.fs_flags = FS_USERNS_MOUNT,
};

static int __init mikuosfs_init(void)
{
	return register_filesystem(&mikuosfs_type);
}
fs_initcall(mikuosfs_init);
